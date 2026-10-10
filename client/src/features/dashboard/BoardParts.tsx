import clsx from "clsx";
import {
  Archive,
  ArchiveRestore,
  DoorOpen,
  Ellipsis,
  ExternalLink,
  Link2,
  PencilLine,
  RotateCcw,
  Star,
  Trash2,
  X,
} from "lucide-react";
import { Menu, MenuItem, MenuSeparator } from "../../components/Menu";
import { isMember, ROLES } from "./sections";
import type { BoardRole, BoardSummary } from "./sections";

/** What the dashboard can do to boards; the menus, cards and rows call these. */
export type BoardActions = {
  rename: (board: BoardSummary) => void;
  askLeave: (board: BoardSummary) => void;
  askPurge: (boards: BoardSummary[]) => void;
  copyLink: (board: BoardSummary) => void;
  toggleStar: (board: BoardSummary) => void;
  archive: (boards: BoardSummary[], archived: boolean) => void;
  trash: (boards: BoardSummary[]) => void;
  restore: (boards: BoardSummary[]) => void;
  forget: (board: BoardSummary) => void;
};

export function RoleBadge({ role, className }: { role: BoardRole; className?: string }) {
  const { label, icon: Icon, viaLink } = ROLES[role] ?? ROLES.viewer;
  return (
    <span
      className={clsx(
        "inline-flex h-6 items-center gap-1 rounded-full bg-ink/6 px-2 text-xs font-medium whitespace-nowrap text-graphite",
        className,
      )}
      title={viaLink ? "You have this board through its link" : undefined}
    >
      {viaLink ? <Link2 className="size-3" aria-hidden /> : <Icon className="size-3" aria-hidden />}
      {label}
    </span>
  );
}

type StarButtonProps = { board: BoardSummary; onToggle: (board: BoardSummary) => void; className?: string };

export function StarButton({ board, onToggle, className }: StarButtonProps) {
  return (
    <button
      type="button"
      aria-pressed={board.starred}
      aria-label={board.starred ? `Unstar ${board.title}` : `Star ${board.title}`}
      title={board.starred ? "Unstar" : "Star"}
      onClick={() => onToggle(board)}
      className={clsx(
        "grid size-8 place-items-center rounded-lg transition-colors hover:bg-ink/8",
        board.starred
          ? "text-[#e8a90c]"
          : "text-graphite opacity-0 group-focus-within:opacity-100 group-hover:opacity-100 focus-visible:opacity-100 [@media(pointer:coarse)]:opacity-100",
        className,
      )}
    >
      <Star className={clsx("size-4", board.starred && "fill-current")} aria-hidden />
    </button>
  );
}

/**
 * The "..." menu for a board. What it offers depends on who you are on the board:
 * owners can trash it, invited editors can leave it, and people who only have the
 * link can just remove it from their list.
 */
type BoardMenuProps = { board: BoardSummary; trashed?: boolean; actions: BoardActions };

export function BoardMenu({ board, trashed = false, actions }: BoardMenuProps) {
  const member = isMember(board);
  return (
    <Menu
      trigger={(props) => (
        <button
          type="button"
          aria-label={`Options for ${board.title}`}
          className="grid size-8 place-items-center rounded-lg text-graphite transition-colors hover:bg-ink/6 hover:text-ink"
          {...props}
        >
          <Ellipsis className="size-4" aria-hidden />
        </button>
      )}
    >
      {trashed ? (
        <>
          <MenuItem icon={RotateCcw} onSelect={() => actions.restore([board])}>
            Restore
          </MenuItem>
          <MenuItem icon={Trash2} tone="danger" onSelect={() => actions.askPurge([board])}>
            Delete forever
          </MenuItem>
        </>
      ) : (
        <>
          <MenuItem icon={ExternalLink} onSelect={() => window.open(`/board/${board.id}`, "_blank", "noopener")}>
            Open in new tab
          </MenuItem>
          <MenuItem icon={Link2} onSelect={() => actions.copyLink(board)}>
            Copy link
          </MenuItem>
          {member && (
            <MenuItem icon={PencilLine} onSelect={() => actions.rename(board)}>
              Rename
            </MenuItem>
          )}
          <MenuSeparator />
          {member && (
            <MenuItem icon={Star} onSelect={() => actions.toggleStar(board)}>
              {board.starred ? "Unstar" : "Star"}
            </MenuItem>
          )}
          <MenuItem
            icon={board.archived ? ArchiveRestore : Archive}
            onSelect={() => actions.archive([board], !board.archived)}
          >
            {board.archived ? "Unarchive" : "Archive"}
          </MenuItem>
          <MenuSeparator />
          {board.role === "owner" && (
            <MenuItem icon={Trash2} tone="danger" onSelect={() => actions.trash([board])}>
              Move to trash
            </MenuItem>
          )}
          {board.role === "editor" && (
            <MenuItem icon={DoorOpen} tone="danger" onSelect={() => actions.askLeave(board)}>
              Leave board
            </MenuItem>
          )}
          {!member && (
            <MenuItem icon={X} onSelect={() => actions.forget(board)}>
              Remove from my list
            </MenuItem>
          )}
        </>
      )}
    </Menu>
  );
}
