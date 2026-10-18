import { MAX_ALT_LENGTH, MAX_FRAME_NAME_LENGTH, MAX_TEXT_LENGTH } from "./limits.ts";
import type { Element, FieldGroup, Splice, TextBases, TextField } from "./types.ts";

// How two people typing in the same text at once both keep what they typed.
//
// Everything else about an element is a last-writer-wins register (see board-merge.ts), and so was
// text: of two edits to one note, the newer replaced the other whole. Now a change that types into a
// text carries its `base`, the text as it was on the screen it was made on. Where the text has
// changed since (someone else's typing got there first), the two changes are merged, letter by
// letter, as a three-way merge does: what the base became on the board, and what it became on that
// screen, are worked out as character diffs, and both are applied. A letter either of them deleted
// is gone; what either of them typed is kept, where they typed it. Two people typing at the same
// spot keep both, what was there first ahead (as a text CRDT such as Yjs would).
//
// The merge is made where changes meet in order: on the server, which everyone takes the board
// from, and in the browser, when it stamps its own change over a text that changed while it was
// being typed (see store.ts) or shows someone else's typing in the text being edited (see
// TextEditor.tsx). A merged text is stamped newer than both of the changes in it, so it replaces
// either one, wherever it arrives.

/** The fields people type into, with the property group each belongs to and the longest it may be. */
export const TEXT_FIELDS: Record<TextField, { group: FieldGroup; max: number }> = {
  text: { group: "text", max: MAX_TEXT_LENGTH },
  alt: { group: "text", max: MAX_ALT_LENGTH },
  name: { group: "name", max: MAX_FRAME_NAME_LENGTH },
};

/** A change to a text: the letters from `start` up to `end` replaced by `insert` (in the text it was made to). */
export type Hunk = [start: number, end: number, insert: string];

// How much work one diff may take (about a millisecond). Typing is a few changes in a few places,
// which takes far less; two unrelated texts of thousands of letters take more, and aren't merged:
// the newer change wins, as it always did. It also keeps a change sent to the server to make it
// work hard from taking long.
const DIFF_BUDGET = 100_000;

/**
 * The changes that turn `from` into `to`, as few letters added and removed as can be (Myers' diff),
 * in order, none touching another. Null when that's more work than DIFF_BUDGET.
 */
export function diffText(from: string, to: string): Hunk[] | null {
  // Typing usually changes one stretch: what's the same at either end is left out first.
  const [prefix, suffix] = sameEnds(from, to);
  const a = from.slice(prefix, from.length - suffix);
  const b = to.slice(prefix, to.length - suffix);
  if (a.length === 0 && b.length === 0) return [];
  if (a.length === 0 || b.length === 0) return [[prefix, prefix + a.length, b]];
  const edits = shortestEdit(a, b);
  if (!edits) return null;
  const hunks: Hunk[] = [];
  for (const [at, inserted] of edits) {
    const last = hunks.at(-1);
    if (last && last[1] === prefix + at) {
      if (inserted === null) last[1] += 1;
      else last[2] += inserted;
    } else hunks.push(inserted === null ? [prefix + at, prefix + at + 1, ""] : [prefix + at, prefix + at, inserted]);
  }
  return hunks;
}

// How many letters `a` and `b` have the same at the start, and then at the end.
function sameEnds(a: string, b: string): [prefix: number, suffix: number] {
  const shorter = Math.min(a.length, b.length);
  let prefix = 0;
  while (prefix < shorter && a.charCodeAt(prefix) === b.charCodeAt(prefix)) prefix += 1;
  let suffix = 0;
  while (suffix < shorter - prefix && a.charCodeAt(a.length - 1 - suffix) === b.charCodeAt(b.length - 1 - suffix))
    suffix += 1;
  return [prefix, suffix];
}

// The fewest single-letter edits from `a` to `b`, in order: [where in `a`, the letter of `b` put
// there] for an insert, [where in `a`, null] for a delete. Myers' O((N+M)D) algorithm, keeping each
// round's furthest reach (only the diagonals it touched) to trace the path back. Null past DIFF_BUDGET.
function shortestEdit(a: string, b: string): [at: number, inserted: string | null][] | null {
  const n = a.length;
  const m = b.length;
  const offset = n + m + 1;
  const reach = new Int32Array(2 * offset + 1);
  const rounds: Int32Array[] = [];
  let work = 0;
  for (let d = 0; d <= n + m; d += 1) {
    // Before round d: diagonals -d-1 to d+1, as round d reads them.
    rounds.push(reach.slice(offset - d - 1, offset + d + 2));
    for (let k = -d; k <= d; k += 2) {
      let x =
        k === -d || (k !== d && reach[offset + k - 1] < reach[offset + k + 1])
          ? reach[offset + k + 1]
          : reach[offset + k - 1] + 1;
      let y = x - k;
      const start = x;
      while (x < n && y < m && a.charCodeAt(x) === b.charCodeAt(y)) {
        x += 1;
        y += 1;
      }
      work += 1 + x - start;
      reach[offset + k] = x;
      if (x >= n && y >= m) return traceBack(rounds, n, m, b);
    }
    if (work > DIFF_BUDGET) return null;
  }
  return null; // not reached: round n + m always gets there
}

function traceBack(rounds: Int32Array[], n: number, m: number, b: string): [number, string | null][] {
  const edits: [number, string | null][] = [];
  let x = n;
  let y = m;
  for (let d = rounds.length - 1; d > 0; d -= 1) {
    const before = rounds[d];
    const at = (k: number) => before[k + d + 1];
    const k = x - y;
    const down = k === -d || (k !== d && at(k - 1) < at(k + 1));
    const fromK = down ? k + 1 : k - 1;
    const fromX = at(fromK);
    const fromY = fromX - fromK;
    edits.push(down ? [fromX, b[fromY]] : [fromX, null]);
    x = fromX;
    y = fromY;
  }
  return edits.reverse();
}

/**
 * `base` with both what turned it into `current` and what turned it into `incoming` applied. A letter
 * either deleted is gone, and what either typed is kept; typed at the same spot, `current`'s goes first.
 * Two changes that come to the same text are one change made twice, and kept once. Null when the diffs
 * are too much work (see DIFF_BUDGET), or the result is longer than `max`: then the newer change wins whole.
 */
export function mergeText(base: string, current: string, incoming: string, max = Infinity): string | null {
  if (incoming === current || incoming === base) return current;
  if (current === base) return incoming;
  const ours = diffText(base, current);
  const theirs = diffText(base, incoming);
  if (!ours || !theirs) return null;
  const parts: string[] = [];
  let i = 0;
  let j = 0;
  // Up to where each side has deleted, from the latest change of its that began.
  let oursCut = 0;
  let theirsCut = 0;
  for (let at = 0; at <= base.length; at += 1) {
    let typed = "";
    const mine = ours[i];
    if (mine && mine[0] === at) {
      typed = mine[2];
      oursCut = mine[1];
      i += 1;
    }
    const other = theirs[j];
    if (other && other[0] === at) {
      typed += other[2];
      theirsCut = other[1];
      j += 1;
    }
    parts.push(typed);
    if (at < base.length && at >= oursCut && at >= theirsCut) parts.push(base[at]);
  }
  const merged = parts.join("");
  return merged.length <= max ? merged : null;
}

/**
 * Where a place in a text (a caret) is once `hunks` have changed it. Text added right at the place goes
 * after it, so someone typing there carries on before it; a place inside a stretch that was replaced
 * goes to the end of the replacement.
 */
export function mapIndex(hunks: readonly Hunk[], index: number): number {
  let shift = 0;
  for (const [start, end, insert] of hunks) {
    if (start >= index) break;
    if (end > index) return start + shift + insert.length;
    shift += insert.length - (end - start);
  }
  return index + shift;
}

/** A text being typed in an editor: what's typed so far, the text on the board it's typed against, and the selection. */
export type Typing = { value: string; base: string; start: number; end: number };

/**
 * `typing` once the text on the board has become `board` (someone else typed in it): their change is
 * merged into what's being typed, as the server will merge the two once it's committed, and the
 * selection keeps its place among the letters around it (see mapIndex).
 */
export function followText(typing: Typing, board: string): Typing {
  if (board === typing.base) return typing;
  const value = mergeText(typing.base, board, typing.value, MAX_TEXT_LENGTH) ?? typing.value;
  const hunks = diffText(typing.value, value) ?? [];
  return { value, base: board, start: mapIndex(hunks, typing.start), end: mapIndex(hunks, typing.end) };
}

/** What `before` was, told against what it is `now`: usually a few letters, not the whole text again. */
export function spliceOf(before: string, now: string): Splice {
  const [prefix, suffix] = sameEnds(before, now);
  return [prefix, suffix, before.slice(prefix, before.length - suffix)];
}

/** The text that was, from what it is `now` and its splice (see spliceOf). */
export const textBefore = (now: string, [prefix, suffix, middle]: Splice): string =>
  now.slice(0, prefix) + middle + now.slice(now.length - suffix);

/** The bases a change says it was typed against, where they fit what `element` has; undefined if none do. */
export function cleanBases(raw: unknown, element: Element): TextBases | undefined {
  if (!raw || typeof raw !== "object" || Array.isArray(raw)) return undefined;
  const clean: TextBases = {};
  // Object.keys can only say "strings"; these are the keys of TEXT_FIELDS, so they are text fields.
  for (const field of Object.keys(TEXT_FIELDS) as TextField[]) {
    // An object that isn't an array got this far, and each part is checked below before it's used.
    const splice = (raw as Record<string, unknown>)[field];
    const now = (element as Record<string, unknown>)[field];
    if (typeof now !== "string" || !Array.isArray(splice) || splice.length !== 3) continue;
    const [prefix, suffix, middle] = splice as unknown[];
    if (
      Number.isSafeInteger(prefix) &&
      Number.isSafeInteger(suffix) &&
      (prefix as number) >= 0 &&
      (suffix as number) >= 0 &&
      (prefix as number) + (suffix as number) <= now.length &&
      typeof middle === "string" &&
      middle.length <= TEXT_FIELDS[field].max
    )
      clean[field] = [prefix as number, suffix as number, middle];
  }
  return Object.keys(clean).length > 0 ? clean : undefined;
}

/** `element` without the bases it was sent with: what a board keeps. */
export function withoutBase(element: Element): Element {
  const { base: _base, ...kept } = element;
  return kept as Element;
}
