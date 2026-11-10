import { STACK_MOVES } from "@inkboard/shared/board-order";
import type { Element as BoardElement, StackMove } from "@inkboard/shared/types";
import { useCallback, useDeferredValue, useMemo } from "react";
import { toast } from "sonner";
import { CLASSROOM_TOAST, FRAME_COPY_GAP } from "../constants/editor";
import { canChange, clampShift, staysInside } from "../lib/elements/classroom";
import type { Zone } from "../lib/elements/classroom";
import { copyGroup, moveGroup } from "../lib/elements/connectors";
import { isFrame, withContents } from "../lib/elements/elements";
import { stackKey } from "../lib/elements/order";
import { copyOffset } from "../lib/elements/placement";
import { getSelectionBox, resizeElement, uncropImage } from "../lib/elements/transform";
import type { BoardStore } from "../lib/sync/store";

interface SelectionActionsOptions {
  store: BoardStore;
  elements: BoardElement[];
  selected: BoardElement | null;
  selectedId: string | null;
  setSelectedId: (id: string | null) => void;
  zone: Zone;
  readOnly: boolean;
  zoom: number;
  toastWithUndo: (message: string) => void;
}

export function useSelectionActions({
  store,
  elements,
  selected,
  selectedId,
  setSelectedId,
  zone,
  readOnly,
  zoom,
  toastWithUndo,
}: SelectionActionsOptions) {
  const selectedGroup = useCallback(() => {
    const element = selectedId && store.getElement(selectedId);
    // In classroom mode, a student can't change what isn't in their frame, even picked from the outline.
    return element && canChange(element, zone) ? withContents(store.getElements(), element) : [];
  }, [selectedId, store, zone]);

  const deleteSelected = useCallback(() => {
    const group = selectedGroup();
    if (group.length === 0) return;
    // Connectors attached to what's deleted stay where they're drawn (the store lets go of them).
    store.commit({ undo: { upsert: group }, redo: { remove: group.map((element) => element.id) } });
    setSelectedId(null);
    if (group.length > 1) {
      const count = group.length - 1;
      toastWithUndo(`Frame and ${count} ${count === 1 ? "element" : "elements"} in it deleted`);
    }
  }, [selectedGroup, store, setSelectedId, toastWithUndo]);

  const duplicateSelected = useCallback(() => {
    const group = selectedGroup();
    if (group.length === 0) return;
    // A frame's copy goes beside it, so the two don't overlap and claim each other's contents.
    const [dx, dy] = isFrame(group[0]) ? copyOffset(store.getElements(), group, FRAME_COPY_GAP) : [16, 16];
    const copies = copyGroup(store.getElements(), group, dx, dy);
    if (!copies.every((copy) => staysInside(copy, zone))) {
      toast("There's no room for a copy inside your frame there. Move it first.", { id: CLASSROOM_TOAST });
      return;
    }
    store.commit({ undo: { remove: copies.map((copy) => copy.id) }, redo: { upsert: copies } });
    setSelectedId(copies[0].id);
  }, [selectedGroup, store, zone, setSelectedId]);

  // Only the stacking key changes, so it merges with anyone else's edits to the element.
  const moveSelected = useCallback(
    (where: StackMove) => {
      const element = selectedId && store.getElement(selectedId);
      if (!element || !canChange(element, zone)) return;
      const index = stackKey(store.getElements(), element, where);
      if (!index) return;
      store.commit({ undo: { upsert: [element] }, redo: { upsert: [{ ...element, index }] } });
    },
    [selectedId, store, zone],
  );
  // Each stack move takes a pass over the board, so it's worked out when the board is quiet, not on every drag step.
  const settledElements = useDeferredValue(elements);
  const settledSelection = useDeferredValue(selected);
  const stackMoves = useMemo<Partial<Record<StackMove, boolean>>>(
    () =>
      settledSelection && !readOnly
        ? Object.fromEntries(
            STACK_MOVES.map((where) => [where, stackKey(settledElements, settledSelection, where) !== null]),
          )
        : {},
    [settledElements, settledSelection, readOnly],
  );

  const nudgeSelected = useCallback(
    (dx: number, dy: number) => {
      const group = selectedGroup();
      if (group.length === 0) return;
      const [x, y] = zone ? clampShift(group, zone, dx, dy) : [dx, dy];
      if (x === 0 && y === 0) return;
      // Nudges in a row are one undo step while they move the same things; a frame nudged over something takes it along
      // from then on, a new step the first one's undo doesn't know about.
      store.commit(
        { undo: { upsert: group }, redo: { upsert: moveGroup(store.getElements(), group, x, y) } },
        { mergeKey: `nudge:${group.map((element) => element.id).join(",")}` },
      );
    },
    [selectedGroup, store, zone],
  );

  function resizeSelected(dx: number, dy: number) {
    const element = selectedId && store.getElement(selectedId);
    if (!element || !canChange(element, zone)) return;
    const box = getSelectionBox(element, zoom);
    // The assertion: a box has a bottom right corner, a line an end.
    const handle = box.handles.find((each) => each.id === "se" || each.id === "end")!;
    const next = resizeElement(
      element,
      handle.id,
      { x: handle.x + dx, y: handle.y + dy },
      {
        pad: box.kind === "box" ? box.pad : 0,
      },
    );
    if (!staysInside(next, zone)) return;
    store.commit({ undo: { upsert: [element] }, redo: { upsert: [next] } }, { mergeKey: `resize:${element.id}` });
  }

  function uncropSelected() {
    if (selected?.type !== "image") return;
    store.commit({ undo: { upsert: [selected] }, redo: { upsert: [uncropImage(selected)] } });
  }

  return {
    selectedGroup,
    deleteSelected,
    duplicateSelected,
    moveSelected,
    stackMoves,
    nudgeSelected,
    resizeSelected,
    uncropSelected,
  };
}
