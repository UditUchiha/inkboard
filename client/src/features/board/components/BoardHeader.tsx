import { useCallback } from "react";
import { Link } from "react-router";
import { LogoMark } from "../../../components/Logo";
import { api } from "../../../lib/api";
import type { AccountUser, BoardMeta } from "../../../lib/api";
import { BoardTitle } from "./BoardTitle";
import type { RenamedBoard } from "./BoardTitle";

export interface BoardHeaderProps {
  board: BoardMeta;
  user: AccountUser | null;
  local: boolean;
  readOnly: boolean;
  onRenamed: (updated: RenamedBoard) => void;
}

export function BoardHeader({ board, user, local, readOnly, onRenamed }: BoardHeaderProps) {
  const renameBoard = useCallback(
    async (title: string): Promise<RenamedBoard> =>
      local ? { title } : (await api.renameBoard(board.id, title)).board,
    [local, board.id],
  );

  return (
    <div className="floating-panel absolute top-3 left-3 flex items-center gap-0.5 rounded-xl p-1">
      <Link
        to={user ? "/boards" : "/"}
        title={user ? "All boards" : "Home"}
        aria-label={user ? "All boards" : "Home"}
        className="grid size-10 place-items-center rounded-lg transition-colors hover:bg-ink/6"
      >
        <LogoMark className="size-6" />
      </Link>
      <BoardTitle board={board} rename={renameBoard} readOnly={readOnly} onRenamed={onRenamed} />
    </div>
  );
}
