import { useState } from "react";
import { toast } from "sonner";
import { ConfirmDialog } from "../../../components/Dialog";
import { api, errorMessage } from "../../../lib/api";
import { quoted } from "../lib/boardText";
import type { useBoards } from "../hooks/useBoards";
import type { Confirm } from "../types/confirm";

interface BoardConfirmDialogProps extends Pick<ReturnType<typeof useBoards>, "drop" | "refresh"> {
  confirm: Confirm | null;
  trashCount: number;
  onClose: () => void;
  clearSelection: () => void;
}

export function BoardConfirmDialog({
  confirm,
  trashCount,
  onClose,
  drop,
  refresh,
  clearSelection,
}: BoardConfirmDialogProps) {
  const [busy, setBusy] = useState(false);

  async function confirmAction() {
    const { kind, boards: targets } = confirm!;
    setBusy(true);
    try {
      if (kind === "leave") {
        await api.removeCollaborator(targets[0].id, "me");
        drop([targets[0].id]);
        toast.success(`Left “${targets[0].title}”`);
      } else if (kind === "empty") {
        await api.emptyTrash();
        await refresh();
        toast.success("Trash emptied");
      } else {
        const results = await Promise.allSettled(targets.map((board) => api.purgeBoard(board.id)));
        await refresh();
        clearSelection();
        if (results.some((result) => result.status === "rejected")) toast.error("Some boards couldn't be deleted.");
        else toast.success(`Deleted ${quoted(targets)} forever`);
      }
      onClose();
    } catch (error) {
      toast.error(errorMessage(error));
    } finally {
      setBusy(false);
    }
  }

  const confirmCopy = {
    leave: {
      title: `Leave “${confirm?.boards[0].title}”?`,
      description: "You'll lose access until the owner invites you again.",
      label: "Leave board",
    },
    purge: {
      title:
        confirm?.boards.length === 1
          ? `Delete “${confirm.boards[0].title}” forever?`
          : `Delete ${confirm?.boards.length} boards forever?`,
      description: "The drawings, comments and history are erased for everyone. This can't be undone.",
      label: "Delete forever",
    },
    empty: {
      title: "Empty the trash?",
      description: `${trashCount === 1 ? "1 board" : `${trashCount} boards`} will be erased forever, with their comments and history. This can't be undone.`,
      label: "Empty trash",
    },
  }[confirm?.kind ?? "leave"];

  return (
    <ConfirmDialog
      open={Boolean(confirm)}
      onClose={onClose}
      onConfirm={confirmAction}
      busy={busy}
      title={confirmCopy.title}
      description={confirmCopy.description}
      confirmLabel={confirmCopy.label}
    />
  );
}
