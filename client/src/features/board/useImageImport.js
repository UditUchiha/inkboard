import { useCallback, useEffect, useRef } from "react";
import { toast } from "sonner";
import { BoardFileError, dataUrlToBlob, isBoardFile, placeElements, readBoardFile } from "./boardFile";
import { MAX_ELEMENTS_PER_BOARD } from "./constants";
import { isTypingTarget } from "./domTargets";
import { createImage } from "./elements";
import { toWorld } from "./geometry";
import { ImageError, isImageFile, placementSize, prepareImage, primeImage, uploadImage } from "./images";

const MAX_IMAGES_AT_ONCE = 10;

/**
 * Putting pictures and board files on the board: from the toolbar and menu (`addImages`,
 * `importBoardFile`), and by pasting or dropping them anywhere on the page. `view` is a ref
 * to `{ viewport, canvasSize }`, so a picture lands where the screen is now, not where it was
 * when the upload started. `setTool` and `setSelectedId` select what was added.
 */
export function useImageImport({ store, socket, boardId, local, readOnly, view, setTool, setSelectedId }) {
  // Adds pictures to the board: shrinks and uploads each, then places it where it
  // was dropped, or in the middle of the screen. Each one is a single undo step.
  const addImages = useCallback(
    async (files, dropPoint = null) => {
      if (local) {
        toast("Save this board to your account to add images.");
        return;
      }
      const batch = files.slice(0, MAX_IMAGES_AT_ONCE);
      if (batch.length < files.length) {
        toast.warning(`Adding the first ${batch.length} of ${files.length} images. Add the rest in another go.`);
      }
      for (const [index, file] of batch.entries()) {
        const progress = toast.loading(
          batch.length > 1 ? `Adding image ${index + 1} of ${batch.length}…` : "Adding image…",
        );
        try {
          const picked = await prepareImage(file);
          const id = await uploadImage(socket, boardId, picked);
          primeImage(id, picked.blob);
          if (picked.small) primeImage(id, picked.small, { small: true });

          const { viewport: vp, canvasSize: size } = view.current;
          const area = { width: size.width / vp.zoom, height: size.height / vp.zoom };
          const middle = dropPoint ?? { x: -vp.x + area.width / 2, y: -vp.y + area.height / 2 };
          const shift = index * 24; // keep several pictures from landing exactly on top of each other
          const fitted = placementSize(picked, area);
          const element = createImage(
            id,
            { x: middle.x - fitted.width / 2 + shift, y: middle.y - fitted.height / 2 + shift },
            fitted,
          );
          store.commit({ undo: { remove: [element.id] }, redo: { upsert: [element] } });
          setTool("select");
          setSelectedId(element.id);
          toast.dismiss(progress);
        } catch (error) {
          toast.error(error instanceof ImageError ? error.message : "That image couldn't be added.", { id: progress });
        }
      }
    },
    [local, socket, boardId, store, view, setTool, setSelectedId],
  );

  // Adds what's in a board file (see boardFile.js) to this board, centred on
  // the screen, as one undo step. Its pictures are uploaded again so they
  // belong to this board.
  const importBoardFile = useCallback(
    async (file) => {
      let parsed;
      try {
        parsed = await readBoardFile(file);
      } catch (error) {
        toast.error(error instanceof BoardFileError ? error.message : "That file couldn't be read.");
        return;
      }
      if (store.getElements().length + parsed.elements.length > MAX_ELEMENTS_PER_BOARD) {
        toast.error(
          `That would put more than ${MAX_ELEMENTS_PER_BOARD} elements on this board. Import it into a new board instead.`,
        );
        return;
      }

      const progress = toast.loading(`Importing ${file.name}…`);
      const uploaded = new Map(); // image id in the file -> id on this board
      const failures = []; // why pictures couldn't be added
      const wanted = new Set(
        parsed.elements.filter((element) => element.type === "image").map((element) => element.imageId),
      );
      if (!local) {
        for (const oldId of wanted) {
          const url = parsed.pictures.get(oldId);
          if (!url) continue;
          try {
            const blob = dataUrlToBlob(url);
            const picked = await prepareImage(new File([blob], "picture", { type: blob.type }));
            const id = await uploadImage(socket, boardId, picked);
            primeImage(id, picked.blob);
            if (picked.small) primeImage(id, picked.small, { small: true });
            uploaded.set(oldId, id);
          } catch (error) {
            // Left out below, and counted in the message.
            failures.push(
              error instanceof ImageError || error instanceof BoardFileError
                ? error.message
                : "The picture couldn't be uploaded.",
            );
          }
        }
      }

      const kept = parsed.elements.flatMap((element) => {
        if (element.type !== "image") return [element];
        return uploaded.has(element.imageId) ? [{ ...element, imageId: uploaded.get(element.imageId) }] : [];
      });
      const missing = parsed.elements.length - kept.length; // pictures that couldn't be added
      const why = local ? "Save this board to your account to import pictures." : (failures[0] ?? "");
      if (kept.length === 0) {
        toast.error(`None of that file's pictures could be added. ${why}`.trim(), { id: progress });
        return;
      }

      const { viewport: vp, canvasSize: size } = view.current;
      const center = { x: -vp.x + size.width / vp.zoom / 2, y: -vp.y + size.height / vp.zoom / 2 };
      let placed;
      try {
        placed = placeElements(kept, center);
        store.commit({ undo: { remove: placed.map((element) => element.id) }, redo: { upsert: placed } });
      } catch {
        toast.error("That file couldn't be added to the board.", { id: progress });
        return;
      }
      setTool("select");
      setSelectedId(null);
      const added = `Added ${placed.length} ${placed.length === 1 ? "element" : "elements"} from ${file.name}`;
      const left = [];
      if (missing > 0)
        left.push(`${missing} ${missing === 1 ? "picture" : "pictures"} couldn't be added. ${why}`.trim());
      if (parsed.skipped > 0) {
        left.push(`${parsed.skipped} ${parsed.skipped === 1 ? "element" : "elements"} in the file couldn't be read`);
      }
      if (left.length === 0) toast.success(added, { id: progress });
      else toast.warning(`${added}. ${left.join(". ")}`, { id: progress });
    },
    [local, socket, boardId, store, view, setTool, setSelectedId],
  );

  // Pictures (and board files) can be pasted or dropped onto the board.
  const importBoardFileRef = useRef(importBoardFile);
  importBoardFileRef.current = importBoardFile;
  const addImagesRef = useRef(addImages);
  addImagesRef.current = addImages;
  useEffect(() => {
    const imagesIn = (list) => [...(list ?? [])].filter(isImageFile);
    const blocked = (event) => isTypingTarget(event.target) || document.querySelector("dialog[open]");

    const onPaste = (event) => {
      const files = imagesIn(event.clipboardData?.files);
      if (readOnly || files.length === 0 || blocked(event)) return;
      event.preventDefault();
      addImagesRef.current(files);
    };
    const carriesFiles = (event) => [...(event.dataTransfer?.types ?? [])].includes("Files");
    const onDragOver = (event) => {
      if (carriesFiles(event)) event.preventDefault();
    };
    const onDrop = (event) => {
      if (!carriesFiles(event)) return;
      // Left alone, the browser opens a dropped file in the tab, leaving the board,
      // so this happens even for people who can only view it.
      event.preventDefault();
      const files = imagesIn(event.dataTransfer.files);
      if (readOnly || blocked(event)) return;
      const boardFile = [...event.dataTransfer.files].find(isBoardFile);
      if (files.length === 0 && boardFile) {
        importBoardFileRef.current(boardFile);
        return;
      }
      if (files.length === 0) {
        toast.error("Only images (PNG, JPEG, WebP, GIF, AVIF, BMP or HEIC) or Inkboard board files can be added.");
        return;
      }
      const { viewport: vp } = view.current;
      addImagesRef.current(files, toWorld(vp, event.clientX, event.clientY));
    };

    window.addEventListener("paste", onPaste);
    window.addEventListener("dragover", onDragOver);
    window.addEventListener("drop", onDrop);
    return () => {
      window.removeEventListener("paste", onPaste);
      window.removeEventListener("dragover", onDragOver);
      window.removeEventListener("drop", onDrop);
    };
  }, [readOnly, view]);

  return { addImages, importBoardFile };
}
