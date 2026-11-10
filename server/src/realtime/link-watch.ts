import type { Element } from "@inkboard/shared/types";

// Watches what people who came through a board's link (not members) do there, so a leaked link is noticed: the owner is
// told when many join, and when they remove much of the board, a copy of which is kept in version history (see link-alerts.ts).

export const LINK_VISITORS_WARNING = 10;
export const MASS_REMOVAL = 30;
export const REMOVAL_WINDOW_MS = 10 * 60_000;

export interface LinkWatch {
  visitors: Set<string>;
  removals: { since: number; count: number; before: Element[]; warned: boolean } | null;
}

export const emptyLinkWatch = (): LinkWatch => ({ visitors: new Set(), removals: null });

export function noteVisitor(watch: LinkWatch, id: string): boolean {
  if (watch.visitors.has(id)) return false;
  watch.visitors.add(id);
  return watch.visitors.size === LINK_VISITORS_WARNING;
}

// Returns the board from before the first removal once MASS_REMOVAL is reached within the window (once per window), else
// null. Elements are never changed in place, so keeping `before` costs nothing.
export function noteRemovals(watch: LinkWatch, count: number, before: Element[], now = Date.now()): Element[] | null {
  if (!watch.removals || now - watch.removals.since > REMOVAL_WINDOW_MS) {
    watch.removals = { since: now, count: 0, before, warned: false };
  }
  const removals = watch.removals;
  removals.count += count;
  if (removals.warned || removals.count < MASS_REMOVAL) return null;
  removals.warned = true;
  return removals.before;
}
