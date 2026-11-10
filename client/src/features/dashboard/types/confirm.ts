import type { BoardSummary } from "../lib/sections";

export type Confirm = { kind: "leave" | "purge" | "empty"; boards: BoardSummary[] };
