import { useNavigate } from "react-router";
import { toast } from "sonner";
import { api, errorMessage } from "../../../lib/api";
import type { BoardMeta } from "../../../lib/api";
import type { Exporter } from "../components/BoardMenu";
import { ExportError } from "../lib/files/exportSize";
import type { BoardStore } from "../lib/sync/store";

interface BoardCommandsOptions {
  store: BoardStore;
  board: BoardMeta;
  toastWithUndo: (message: string) => void;
  setSelectedId: (id: string | null) => void;
  closeDialog: () => void;
}

export function useBoardCommands({ store, board, toastWithUndo, setSelectedId, closeDialog }: BoardCommandsOptions) {
  const navigate = useNavigate();

  async function exportAs(exporter: Exporter) {
    try {
      const done = await exporter(store.getElements(), board.title);
      if (!done) toast("Draw something first. There's nothing to export yet.");
    } catch (error) {
      toast.error(error instanceof ExportError ? error.message : "The board couldn't be exported. Try again.");
    }
  }

  async function makeCopy() {
    try {
      const { board: copy } = await api.copyBoard(board.id);
      navigate(`/board/${copy.id}`);
      toast.success("This is your copy. Changes here don't change the original.");
    } catch (error) {
      toast.error(errorMessage(error));
    }
  }

  function clearBoard() {
    const all = store.getElements();
    store.commit({ undo: { upsert: all }, redo: { remove: all.map((element) => element.id) } });
    setSelectedId(null);
    closeDialog();
    toastWithUndo("Board cleared");
  }

  return { exportAs, makeCopy, clearBoard };
}
