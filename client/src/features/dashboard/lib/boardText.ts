import type { BoardSummary } from "./sections";

export const quoted = (boards: BoardSummary[]) =>
  boards.length === 1 ? `“${boards[0].title}”` : `${boards.length} boards`;
