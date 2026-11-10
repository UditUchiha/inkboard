import type { Element as BoardElement } from "@inkboard/shared/types";
import { useCallback, useEffect, useRef, useState } from "react";
import { api, errorMessage } from "../../../lib/api";
import type { BoardSummary } from "../lib/sections";

const PREVIEW_BATCH = 24;

// A preview belongs to one version of a board; one changed since it was asked for needs its own.
const previewKey = (board: BoardSummary) => `${board.id}@${board.updatedAt}`;

export function fillPreviews(list: BoardSummary[] | null | undefined, found: Map<string, BoardElement[]>) {
  return list?.map((board) =>
    found.has(previewKey(board)) ? { ...board, preview: found.get(previewKey(board)) } : board,
  );
}

const fetchLists = () => Promise.all([api.listBoards(), api.listTrash()]);

export function useBoards() {
  // A change landing while the list is null leaves it undefined, which only an update to a board that isn't there could
  // do.
  const [boards, setBoards] = useState<BoardSummary[] | null | undefined>(null);
  const [trash, setTrash] = useState<BoardSummary[] | undefined>([]);
  const [loadError, setLoadError] = useState("");
  const previews = useRef(new Map<string, { updatedAt: string; preview: BoardElement[] | undefined }>());
  const asked = useRef(new Set<string>()); // preview keys (board id and version) whose preview is on its way

  const withKnownPreview = (board: BoardSummary) => {
    const known = previews.current.get(board.id);
    return known && known.updatedAt === board.updatedAt ? { ...board, preview: known.preview } : board;
  };

  const apply = useCallback(([{ boards: list }, { boards: trashed }]: Awaited<ReturnType<typeof fetchLists>>) => {
    setBoards(list.map(withKnownPreview));
    setTrash(trashed.map(withKnownPreview));
  }, []);

  const refresh = useCallback(async () => apply(await fetchLists()), [apply]);

  useEffect(() => {
    let active = true;
    fetchLists()
      .then(apply)
      .catch((error: unknown) => active && setLoadError(errorMessage(error)));
    return () => {
      active = false;
    };
  }, [apply]);

  const patch = useCallback(
    (ids: string[], changes: Partial<BoardSummary>) =>
      setBoards((list) => list?.map((board) => (ids.includes(board.id) ? { ...board, ...changes } : board))),
    [],
  );
  const drop = useCallback(
    (ids: string[]) => setBoards((list) => list?.filter((board) => !ids.includes(board.id))),
    [],
  );

  const loadPreviews = useCallback(async (wanted: BoardSummary[]) => {
    const todo = wanted.filter((board) => !board.preview && !asked.current.has(previewKey(board)));
    for (const board of todo) asked.current.add(previewKey(board));
    for (let start = 0; start < todo.length; start += PREVIEW_BATCH) {
      const batch = todo.slice(start, start + PREVIEW_BATCH);
      try {
        const { previews: found } = await api.boardPreviews(batch.map((board) => board.id));
        // A board the server sent nothing for (gone, or no longer open to this person) just draws as empty.
        const byKey = new Map(batch.map((board) => [previewKey(board), found[board.id] ?? []]));
        for (const board of batch) {
          // An answer that comes back late mustn't replace the preview of a newer version.
          const known = previews.current.get(board.id);
          if (known && new Date(known.updatedAt) > new Date(board.updatedAt)) continue;
          previews.current.set(board.id, { updatedAt: board.updatedAt, preview: byKey.get(previewKey(board)) });
        }
        setBoards((list) => fillPreviews(list, byKey));
        setTrash((list) => fillPreviews(list, byKey));
      } catch {
        // The cards stay blank; asking again (the next refresh) tries once more.
      } finally {
        for (const board of batch) asked.current.delete(previewKey(board));
      }
    }
  }, []);

  return { boards, trash, loadError, patch, drop, refresh, loadPreviews };
}
