import { MAX_ALT_LENGTH, MAX_FRAME_NAME_LENGTH, MAX_TEXT_LENGTH } from "./limits.ts";
import type { Element, FieldGroup, Splice, TextBases, TextField } from "./types.ts";

// How two people typing in the same text at once both keep what they typed (docs/realtime-sync.md, "Typing in the same
// text"). A change carries its `base`, the text it was made against; where the board's text changed since, both changes
// are applied as character diffs (a three-way merge), and the result is stamped newer than both. Done where changes
// meet in order: on the server, and in the browser when it stamps its own change or shows someone else's typing.

export const TEXT_FIELDS: Record<TextField, { group: FieldGroup; max: number }> = {
  text: { group: "text", max: MAX_TEXT_LENGTH },
  alt: { group: "text", max: MAX_ALT_LENGTH },
  name: { group: "name", max: MAX_FRAME_NAME_LENGTH },
};

export type Hunk = [start: number, end: number, insert: string];

// about a millisecond of work; typing takes far less, two unrelated long texts take more and aren't merged (the newer
// change wins), which also keeps a sent change from making the server work hard
const DIFF_BUDGET = 100_000;

// Myers' diff: as few letters added and removed as can be, in order, none touching another. Null past DIFF_BUDGET.
export function diffText(from: string, to: string): Hunk[] | null {
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

function sameEnds(a: string, b: string): [prefix: number, suffix: number] {
  const shorter = Math.min(a.length, b.length);
  let prefix = 0;
  while (prefix < shorter && a.charCodeAt(prefix) === b.charCodeAt(prefix)) prefix += 1;
  let suffix = 0;
  while (suffix < shorter - prefix && a.charCodeAt(a.length - 1 - suffix) === b.charCodeAt(b.length - 1 - suffix))
    suffix += 1;
  return [prefix, suffix];
}

// Myers' O((N+M)D): [where in `a`, the letter put there] for an insert, [where in `a`, null] for a delete; keeps each
// round's reach (only the diagonals it touched) to trace the path back
function shortestEdit(a: string, b: string): [at: number, inserted: string | null][] | null {
  const n = a.length;
  const m = b.length;
  const offset = n + m + 1;
  const reach = new Int32Array(2 * offset + 1);
  const rounds: Int32Array[] = [];
  let work = 0;
  for (let d = 0; d <= n + m; d += 1) {
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

// A letter either deleted is gone; what either typed is kept; typed at the same spot, `current`'s goes first. Two
// changes that come to the same text are one change made twice. Null when the diffs are too much work or the result is
// longer than `max`: the newer change then wins whole.
export function mergeText(base: string, current: string, incoming: string, max = Infinity): string | null {
  if (incoming === current || incoming === base) return current;
  if (current === base) return incoming;
  const ours = diffText(base, current);
  const theirs = diffText(base, incoming);
  if (!ours || !theirs) return null;
  const parts: string[] = [];
  let i = 0;
  let j = 0;
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

// Text added right at the place goes after it, so someone typing there carries on before it; a place inside a replaced
// stretch goes to the end of the replacement.
export function mapIndex(hunks: readonly Hunk[], index: number): number {
  let shift = 0;
  for (const [start, end, insert] of hunks) {
    if (start >= index) break;
    if (end > index) return start + shift + insert.length;
    shift += insert.length - (end - start);
  }
  return index + shift;
}

export type Typing = { value: string; base: string; start: number; end: number };

// `board` is the text after someone else typed in it: their change is merged into what's typed, as the server will
// merge the two, and the selection keeps its place (see mapIndex).
export function followText(typing: Typing, board: string): Typing {
  if (board === typing.base) return typing;
  const value = mergeText(typing.base, board, typing.value, MAX_TEXT_LENGTH) ?? typing.value;
  const hunks = diffText(typing.value, value) ?? [];
  return { value, base: board, start: mapIndex(hunks, typing.start), end: mapIndex(hunks, typing.end) };
}

export function spliceOf(before: string, now: string): Splice {
  const [prefix, suffix] = sameEnds(before, now);
  return [prefix, suffix, before.slice(prefix, before.length - suffix)];
}

export const textBefore = (now: string, [prefix, suffix, middle]: Splice): string =>
  now.slice(0, prefix) + middle + now.slice(now.length - suffix);

export function cleanBases(raw: unknown, element: Element): TextBases | undefined {
  if (!raw || typeof raw !== "object" || Array.isArray(raw)) return undefined;
  const clean: TextBases = {};
  // Object.keys says only "strings"; these are the keys of TEXT_FIELDS
  for (const field of Object.keys(TEXT_FIELDS) as TextField[]) {
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

export function withoutBase(element: Element): Element {
  const { base: _base, ...kept } = element;
  return kept as Element;
}
