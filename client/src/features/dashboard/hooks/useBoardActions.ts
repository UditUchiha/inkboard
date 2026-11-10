import { useNavigate } from "react-router";
import { toast } from "sonner";
import { api, errorMessage } from "../../../lib/api";
import { quoted } from "../lib/boardText";
import type { BoardSummary } from "../lib/sections";
import type { Confirm } from "../types/confirm";
import type { useBoards } from "./useBoards";

interface UseBoardActionsOptions extends Pick<ReturnType<typeof useBoards>, "patch" | "drop" | "refresh"> {
  onRename: (board: BoardSummary) => void;
  onConfirm: (confirm: Confirm) => void;
  clearSelection: () => void;
}

export function useBoardActions({ patch, drop, refresh, onRename, onConfirm, clearSelection }: UseBoardActionsOptions) {
  const navigate = useNavigate();

  const actions = {
    rename: onRename,
    askLeave: (board: BoardSummary) => onConfirm({ kind: "leave", boards: [board] }),
    askPurge: (list: BoardSummary[]) => onConfirm({ kind: "purge", boards: list }),

    async copyLink(board: BoardSummary) {
      try {
        await navigator.clipboard.writeText(`${window.location.origin}/board/${board.id}`);
        toast.success("Link copied");
      } catch {
        toast.error("Couldn't copy the link.");
      }
    },

    async makeCopy(board: BoardSummary) {
      try {
        const { board: copy } = await api.copyBoard(board.id);
        refresh();
        toast.success(`Made “${copy.title}”`, {
          action: { label: "Open", onClick: () => navigate(`/board/${copy.id}`) },
        });
      } catch (error) {
        toast.error(errorMessage(error));
      }
    },

    async toggleStar(board: BoardSummary) {
      const starred = !board.starred;
      patch([board.id], { starred });
      try {
        await api.starBoard(board.id, starred);
      } catch (error) {
        patch([board.id], { starred: !starred });
        toast.error(errorMessage(error));
      }
    },

    async starAll(list: BoardSummary[]) {
      const starred = !list.every((board) => board.starred);
      patch(
        list.map((board) => board.id),
        { starred },
      );
      clearSelection();
      const results = await Promise.allSettled(list.map((board) => api.starBoard(board.id, starred)));
      results.forEach((result, index) => {
        if (result.status === "rejected") patch([list[index].id], { starred: list[index].starred }); // what it was before
      });
      if (results.some((result) => result.status === "rejected")) toast.error("Some boards couldn't be updated.");
    },

    async archive(list: BoardSummary[], archived: boolean) {
      const before = list.map((board): [string, boolean | undefined] => [board.id, board.archived]);
      patch(
        list.map((board) => board.id),
        { archived },
      );
      try {
        await api.archiveBoards(
          list.map((board) => board.id),
          archived,
        );
      } catch (error) {
        before.forEach(([id, was]) => patch([id], { archived: was }));
        toast.error(errorMessage(error));
        return;
      }
      clearSelection();
      toast(archived ? `Archived ${quoted(list)}` : `Moved ${quoted(list)} out of the archive`, {
        action: { label: "Undo", onClick: () => actions.archive(list, !archived) },
      });
    },

    async trash(list: BoardSummary[]) {
      const results = await Promise.allSettled(list.map((board) => api.deleteBoard(board.id)));
      const done = list.filter((_, index) => results[index].status === "fulfilled");
      if (done.length < list.length) toast.error("Some boards couldn't be moved to the trash.");
      if (done.length === 0) return;
      drop(done.map((board) => board.id));
      clearSelection();
      refresh().catch(() => {});
      toast(`Moved ${quoted(done)} to the trash`, {
        action: { label: "Undo", onClick: () => actions.restore(done, true) },
      });
    },

    async restore(list: BoardSummary[], quiet = false) {
      const results = await Promise.allSettled(list.map((board) => api.restoreBoard(board.id)));
      if (results.some((result) => result.status === "rejected")) toast.error("Some boards couldn't be restored.");
      clearSelection();
      await refresh().catch(() => {});
      if (!quiet) toast.success(`Restored ${quoted(list)}`);
    },

    async forget(board: BoardSummary) {
      try {
        await api.forgetBoard(board.id);
        drop([board.id]);
        toast(`Removed “${board.title}” from your list`, { description: "Open its link again to bring it back." });
      } catch (error) {
        toast.error(errorMessage(error));
      }
    },
  };

  return actions;
}
