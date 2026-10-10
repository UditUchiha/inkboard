import type { Element as BoardElement } from "@inkboard/shared/types";
import { Archive, Eye, LayoutGrid, PenLine, Pencil, Star, Trash2, Users } from "lucide-react";
import type { LucideIcon } from "lucide-react";
import type { Person } from "../../lib/api";

export const TRASH_DAYS = 30;

/** What a person can do on a board. */
export type BoardRole = "owner" | "editor" | "contributor" | "viewer";

/**
 * A board as the dashboard lists it (the fields it reads): without its elements, with a preview once one has
 * been fetched. Dates are the ISO strings the server sends.
 */
export type BoardSummary = {
  id: string;
  title: string;
  role: BoardRole;
  owner: Person;
  collaborators: Person[];
  starred: boolean;
  /** This person's own filing of the board; missing on the trash list. */
  archived?: boolean;
  lastOpenedAt?: string | null;
  updatedAt: string;
  /** What to draw on the card, once it has been fetched. */
  preview?: BoardElement[];
  /** Only on a board in the trash: when it was deleted and when it will be erased for good. */
  deletedAt?: string;
  purgeAt?: string;
};

export type SectionId = "all" | "yours" | "shared" | "starred" | "archived" | "trash";

type Section = {
  id: SectionId;
  label: string;
  icon: LucideIcon;
  group: "boards" | "tidy";
  matches: (board: BoardSummary) => boolean | undefined;
  description: (name: string) => string;
  empty: { title: string; text: string };
};

// Which boards each place on the dashboard shows. The trash is the owner's own
// list from the server, so it has no rule here.
export const SECTIONS: Section[] = [
  {
    id: "all",
    label: "All boards",
    icon: LayoutGrid,
    group: "boards",
    matches: (board) => !board.archived,
    description: (name) => `Good to see you, ${name}.`,
    empty: {
      title: "No boards yet",
      text: "Start a board, then share it by email or link so others can draw with you.",
    },
  },
  {
    id: "yours",
    label: "Your boards",
    icon: PenLine,
    group: "boards",
    matches: (board) => !board.archived && board.role === "owner",
    description: () => "Boards you created.",
    empty: { title: "You haven't created a board", text: "Boards you create show up here." },
  },
  {
    id: "shared",
    label: "Shared with you",
    icon: Users,
    group: "boards",
    matches: (board) => !board.archived && board.role !== "owner",
    description: () => "Boards you were invited to, and boards you opened from a link.",
    empty: {
      title: "Nothing shared with you yet",
      text: "When someone invites you, or you open a board link they sent while signed in, it shows up here.",
    },
  },
  {
    id: "starred",
    label: "Starred",
    icon: Star,
    group: "boards",
    matches: (board) => board.starred,
    description: () => "Boards you starred, for quick access.",
    empty: { title: "No starred boards", text: "Star a board you come back to often and it will be kept here." },
  },
  {
    id: "archived",
    label: "Archived",
    icon: Archive,
    group: "tidy",
    matches: (board) => board.archived,
    description: () => "Out of your way but not deleted. Archiving only affects your own lists.",
    empty: {
      title: "Nothing archived",
      text: "Archive boards you're done with to tidy your lists without deleting anything.",
    },
  },
  {
    id: "trash",
    label: "Trash",
    icon: Trash2,
    group: "tidy",
    matches: () => true,
    description: () =>
      `Boards you delete stay here for ${TRASH_DAYS} days, then they're erased for good. Nobody can open them meanwhile.`,
    empty: { title: "The trash is empty", text: "Boards you delete show up here until you restore or erase them." },
  },
];

type RoleInfo = { label: string; icon: LucideIcon; viaLink: boolean };

// What a person can do on a board. Link roles are for people who aren't invited.
export const ROLES: Record<BoardRole, RoleInfo> = {
  owner: { label: "Owner", icon: PenLine, viaLink: false },
  editor: { label: "Can edit", icon: Pencil, viaLink: false },
  contributor: { label: "Can edit (link)", icon: Pencil, viaLink: true },
  viewer: { label: "View only", icon: Eye, viaLink: true },
};

export const isMember = (board: BoardSummary) => board.role === "owner" || board.role === "editor";

const time = (value: string) => new Date(value).getTime();
const openedAt = (board: BoardSummary) => time(board.lastOpenedAt ?? board.updatedAt);
const byTitle = (a: BoardSummary, b: BoardSummary) =>
  a.title.localeCompare(b.title, undefined, { sensitivity: "base", numeric: true });

/** What the list can be sorted by, and which way. */
export type SortKey = "modified" | "opened" | "title";
export type SortDir = "asc" | "desc";
export type Sort = { key: SortKey; dir: SortDir };

// `value` is the number to sort by, or null to sort by title.
export const SORT_KEYS: Record<
  SortKey,
  { label: string; defaultDir: SortDir; value: ((board: BoardSummary) => number) | null }
> = {
  modified: { label: "Last modified", defaultDir: "desc", value: (board) => time(board.updatedAt) },
  opened: { label: "Last opened", defaultDir: "desc", value: openedAt },
  title: { label: "Title", defaultDir: "asc", value: null },
};

export const DEFAULT_SORT: Sort = { key: "modified", dir: "desc" };

// What isSort reads of an object it knows nothing about yet.
type SortFields = { key: string; dir: unknown };

/** Whether a (possibly stored) value is a sort the dashboard understands. */
export const isSort = (value: unknown): value is Sort =>
  Boolean(value) &&
  typeof value === "object" &&
  // Boolean() has ruled out null but the type can't see it. Fields are read as they come, whatever they hold.
  Object.hasOwn(SORT_KEYS, (value as SortFields).key) &&
  ((value as SortFields).dir === "asc" || (value as SortFields).dir === "desc");

/** How the boards are laid out. */
export type View = "grid" | "list";

export const isView = (value: unknown): value is View => value === "grid" || value === "list";

export function compareBoards({ key, dir }: Sort) {
  const sign = dir === "asc" ? 1 : -1;
  const { value } = SORT_KEYS[key];
  return (a: BoardSummary, b: BoardSummary) => sign * (value ? value(a) - value(b) : byTitle(a, b)) || byTitle(a, b);
}

export function daysLeft(purgeAt: string) {
  return Math.max(0, Math.ceil((time(purgeAt) - Date.now()) / (24 * 3600 * 1000)));
}
