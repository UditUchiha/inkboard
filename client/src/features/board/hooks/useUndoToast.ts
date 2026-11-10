import { useCallback } from "react";
import { toast } from "sonner";
import type { BoardStore } from "../lib/sync/store";

// Undo message for the step just taken; it goes away once anything else is done, since Undo would undo that instead.
export function useUndoToast(store: BoardStore) {
  return useCallback(
    (message: string) => {
      const mark = store.historyMark();
      let stopWatching = () => {};
      const id = toast(message, {
        action: { label: "Undo", onClick: () => store.undo() },
        onDismiss: () => stopWatching(),
        onAutoClose: () => stopWatching(),
      });
      stopWatching = store.subscribe(() => {
        if (store.historyMark() === mark) return;
        stopWatching();
        toast.dismiss(id);
      });
    },
    [store],
  );
}
