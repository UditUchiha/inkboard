import type { Element } from "@inkboard/shared/types";

// Keeping an eye on what people who came through a board's link (not its members) do there, so a link that leaked
// is noticed: the owner is told when many such people join, and when they remove much of the board, of which a copy
// from before is kept in version history (see index.ts).

/** How many people from the link who can change the board make it worth telling the owner. */
export const LINK_VISITORS_WARNING = 10;
/** How many elements removed by people from the link, within REMOVAL_WINDOW_MS, make it worth keeping a copy. */
export const MASS_REMOVAL = 30;
export const REMOVAL_WINDOW_MS = 10 * 60_000;

/** What an open board remembers of its link visitors: who joined, and what they removed lately. */
export interface LinkWatch {
  visitors: Set<string>;
  removals: { since: number; count: number; before: Element[]; warned: boolean } | null;
}

export const emptyLinkWatch = (): LinkWatch => ({ visitors: new Set(), removals: null });

/** Notes that the person `id` joined from the link. True once, when they make LINK_VISITORS_WARNING. */
export function noteVisitor(watch: LinkWatch, id: string): boolean {
  if (watch.visitors.has(id)) return false;
  watch.visitors.add(id);
  return watch.visitors.size === LINK_VISITORS_WARNING;
}

/**
 * Notes that people from the link removed `count` elements from a board that was `before` it. When that makes
 * MASS_REMOVAL within the window, returns the board as it was before the first of them (once a window); else null.
 * Elements are never changed in place, so keeping `before` costs nothing.
 */
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
