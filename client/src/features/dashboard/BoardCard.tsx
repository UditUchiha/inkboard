import clsx from "clsx";
import { Link } from "react-router";
import { AvatarStack } from "../../components/Avatar";
import { timeAgo } from "../../lib/format";
import { useMinute } from "../../lib/useMinute";
import { BoardPreview } from "../board/BoardPreview";
import { BoardMenu, RoleBadge, StarButton } from "./BoardParts";
import type { BoardActions } from "./BoardParts";
import { daysLeft, isMember, ROLES } from "./sections";
import type { BoardSummary } from "./sections";

function subtitle(board: BoardSummary, trashed: boolean) {
  if (trashed) {
    // A board in the trash has both dates; the list it came from is what `trashed` says.
    const left = daysLeft(board.purgeAt!);
    return `Deleted ${timeAgo(board.deletedAt!)} · ${left === 1 ? "1 day" : `${left} days`} left`;
  }
  if (board.role === "owner") return `Edited ${timeAgo(board.updatedAt)}`;
  return `${board.owner.name} · ${ROLES[board.role]?.label ?? "View only"}`;
}

type BoardCardProps = { board: BoardSummary; trashed?: boolean; actions: BoardActions };

export function BoardCard({ board, trashed = false, actions }: BoardCardProps) {
  useMinute();
  const members = [board.owner, ...board.collaborators];
  const preview = (
    <BoardPreview elements={board.preview ?? []} className="aspect-[16/10]">
      {board.preview?.length === 0 && (
        <span className="absolute inset-0 grid place-items-center text-sm text-graphite">Empty board</span>
      )}
    </BoardPreview>
  );

  return (
    <li className="group">
      <div className="relative">
        {trashed ? (
          <div className="graph-paper block overflow-hidden rounded-lg border border-rule opacity-70 [--cell:16px]">
            {preview}
          </div>
        ) : (
          <Link
            to={`/board/${board.id}`}
            tabIndex={-1}
            aria-hidden
            className={clsx(
              "graph-paper block overflow-hidden rounded-lg border border-rule transition-colors [--cell:16px] hover:border-ink",
              board.archived && "opacity-75",
            )}
          >
            {preview}
          </Link>
        )}
        {!trashed && isMember(board) && (
          <StarButton board={board} onToggle={actions.toggleStar} className="absolute top-1.5 left-1.5" />
        )}
        {!trashed && board.role !== "owner" && (
          <RoleBadge role={board.role} className="absolute bottom-2 left-2 bg-surface/90 shadow-sm backdrop-blur" />
        )}
      </div>

      <div className="mt-3 flex items-start gap-2">
        <div className="min-w-0 flex-1">
          <h2 className="truncate font-semibold">
            {trashed ? (
              board.title
            ) : (
              <Link to={`/board/${board.id}`} className="rounded-sm hover:underline hover:underline-offset-4">
                {board.title}
              </Link>
            )}
          </h2>
          <p className="truncate text-sm text-graphite">{subtitle(board, trashed)}</p>
        </div>
        {!trashed && members.length > 1 && isMember(board) && <AvatarStack people={members} size="xs" max={3} />}
        <div className="-mr-1.5">
          <BoardMenu board={board} trashed={trashed} actions={actions} />
        </div>
      </div>
    </li>
  );
}
