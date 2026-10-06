import { Archive, Eye, LayoutGrid, PenLine, Pencil, Star, Trash2, Users } from "lucide-react";

export const TRASH_DAYS = 30;

// Which boards each place on the dashboard shows. The trash is the owner's own
// list from the server, so it has no rule here.
export const SECTIONS = [
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

// What a person can do on a board. Link roles are for people who aren't invited.
export const ROLES = {
  owner: { label: "Owner", icon: PenLine, viaLink: false },
  editor: { label: "Can edit", icon: Pencil, viaLink: false },
  contributor: { label: "Can edit (link)", icon: Pencil, viaLink: true },
  viewer: { label: "View only", icon: Eye, viaLink: true },
};

export const isMember = (board) => board.role === "owner" || board.role === "editor";

const time = (value) => new Date(value).getTime();
const openedAt = (board) => time(board.lastOpenedAt ?? board.updatedAt);
const byTitle = (a, b) => a.title.localeCompare(b.title, undefined, { sensitivity: "base", numeric: true });

export const SORT_KEYS = {
  modified: { label: "Last modified", defaultDir: "desc", value: (board) => time(board.updatedAt) },
  opened: { label: "Last opened", defaultDir: "desc", value: openedAt },
  title: { label: "Title", defaultDir: "asc", value: null },
};

export function compareBoards({ key, dir }) {
  const sign = dir === "asc" ? 1 : -1;
  const { value } = SORT_KEYS[key];
  return (a, b) => sign * (value ? value(a) - value(b) : byTitle(a, b)) || byTitle(a, b);
}

export function daysLeft(purgeAt) {
  return Math.max(0, Math.ceil((time(purgeAt) - Date.now()) / (24 * 3600 * 1000)));
}
