import { toast } from "sonner";
import { MAX_ELEMENTS_PER_BOARD } from "./constants";
import { releaseFrom } from "./connectors";
import { createBoardStore } from "./store";

/** A store for a board someone draws on: connectors let go of shapes that go, and the board has a size limit. */
export function createEditorStore() {
  return createBoardStore({
    release: releaseFrom,
    maxElements: MAX_ELEMENTS_PER_BOARD,
    onFull: () =>
      toast.error(`A board holds up to ${MAX_ELEMENTS_PER_BOARD} elements. Delete something or start a new board.`, {
        id: "board-full",
      }),
  });
}
