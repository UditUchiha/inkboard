import type { Element, Fields, PenElement, Point } from "@inkboard/shared/types";
import type { Types } from "mongoose";
import { Board } from "../models/board.model.ts";
import { getSession } from "../realtime/sessions.js";
import type { BoardDoc } from "./boards.ts";

// Dashboard cards draw each board from a slimmed-down copy of its elements, so a
// page of boards doesn't send every stroke of every drawing. A thumbnail is a few
// hundred pixels wide, so pen strokes keep only the points that change how they
// look at that size, and the busiest boards keep only their biggest elements.
// Shapes and pictures are small already; text is cut to what a thumbnail could show, and
// everything loses the bookkeeping that keeps collaborators' edits in step, which drawing doesn't need.

// A thumbnail shows the board's longer side across about this many device
// pixels; detail finer than one of them can't be seen.
const PREVIEW_DETAIL = 1000;
export const MAX_PREVIEW_ELEMENTS = 1000;
// Text can run to 20,000 characters, but a thumbnail shows a few lines at most.
const PREVIEW_TEXT_LENGTH = 300;

// The box around some points: where they reach on each side.
interface Box {
  minX: number;
  minY: number;
  maxX: number;
  maxY: number;
}

// What extent reads of an element: whichever of these it has (a stroke has points, other kinds corners).
type Located = { points?: Point[]; x1?: number; y1?: number; x2?: number; y2?: number } | null | undefined;

/** An element as a thumbnail draws it (see previewElements). */
export type PreviewElement = Fields;

const round = (value: number, places: number) => Math.round(value * 10 ** places) / 10 ** places;

// The box around an element, from whatever coordinates it has. Text is counted
// by its corner only: its size depends on fonts the server doesn't have.
// (Loops rather than Math.min(...points): a long stroke has too many points to spread.)
function extent(element: Located): Box | null {
  const box = { minX: Infinity, minY: Infinity, maxX: -Infinity, maxY: -Infinity };
  const include = (x: unknown, y: unknown) => {
    if (!Number.isFinite(x) || !Number.isFinite(y)) return;
    // isFinite is only true of numbers, which the type can't follow.
    box.minX = Math.min(box.minX, x as number);
    box.minY = Math.min(box.minY, y as number);
    box.maxX = Math.max(box.maxX, x as number);
    box.maxY = Math.max(box.maxY, y as number);
  };
  if (Array.isArray(element?.points)) {
    for (const point of element.points) if (Array.isArray(point)) include(point[0], point[1]);
  }
  include(element?.x1, element?.y1);
  include(element?.x2, element?.y2);
  return box.minX === Infinity ? null : box;
}

function sceneSize(boxes: (Box | null)[]) {
  const scene = { minX: Infinity, minY: Infinity, maxX: -Infinity, maxY: -Infinity };
  for (const box of boxes) {
    if (!box) continue;
    scene.minX = Math.min(scene.minX, box.minX);
    scene.minY = Math.min(scene.minY, box.minY);
    scene.maxX = Math.max(scene.maxX, box.maxX);
    scene.maxY = Math.max(scene.maxY, box.maxY);
  }
  return scene.minX === Infinity ? 0 : Math.max(scene.maxX - scene.minX, scene.maxY - scene.minY);
}

// Distance from p to the segment a-b.
function distanceToSegment(p: readonly number[], a: readonly number[], b: readonly number[]) {
  const dx = b[0] - a[0];
  const dy = b[1] - a[1];
  const lengthSquared = dx * dx + dy * dy;
  const t =
    lengthSquared === 0 ? 0 : Math.max(0, Math.min(1, ((p[0] - a[0]) * dx + (p[1] - a[1]) * dy) / lengthSquared));
  return Math.hypot(p[0] - (a[0] + t * dx), p[1] - (a[1] + t * dy));
}

/**
 * The points of a line that stay within `tolerance` of it (Ramer-Douglas-Peucker),
 * always including both ends. Iterative, since strokes can have thousands of points.
 */
export function simplifyPoints<Pt extends readonly number[]>(points: Pt[], tolerance: number): Pt[] {
  if (points.length <= 2) return points;
  const keep = new Uint8Array(points.length);
  keep[0] = 1;
  keep[points.length - 1] = 1;
  const stack: [number, number][] = [[0, points.length - 1]];
  while (stack.length > 0) {
    // The loop runs only while the stack has something on it.
    const [first, last] = stack.pop()!;
    let farthest = -1;
    let farthestDistance = tolerance;
    for (let index = first + 1; index < last; index += 1) {
      const distance = distanceToSegment(points[index], points[first], points[last]);
      if (distance > farthestDistance) {
        farthest = index;
        farthestDistance = distance;
      }
    }
    if (farthest !== -1) {
      keep[farthest] = 1;
      stack.push([first, farthest], [farthest, last]);
    }
  }
  return points.filter((_, index) => keep[index]);
}

// What a thumbnail needs of any element: no sync stamps, and no more text than it could show.
function slim(element: Fields): Fields {
  const { version: _version, versionNonce: _versionNonce, stamps: _stamps, ...kept } = element;
  if (typeof kept.text === "string" && kept.text.length > PREVIEW_TEXT_LENGTH) {
    kept.text = kept.text.slice(0, PREVIEW_TEXT_LENGTH);
  }
  return kept;
}

function previewStroke(element: PenElement, tolerance: number): PenElement {
  if (!Array.isArray(element.points)) return element;
  const valid = element.points.filter(
    (point) => Array.isArray(point) && Number.isFinite(point[0]) && Number.isFinite(point[1]),
  );
  const points = simplifyPoints(valid, tolerance).map(([x, y, pressure]): Point => [
    round(x, 1),
    round(y, 1),
    // Without real pen pressure, a stroke's width comes from how far apart its
    // points are, so thinned-out points would draw it too thin. An even middle
    // pressure draws it at its normal width instead.
    element.pressure && Number.isFinite(pressure) ? round(pressure, 2) : 0.5,
  ]);
  return { ...element, points, pressure: true };
}

/** A copy of `elements` that draws the same at thumbnail size, with much less data. */
export function previewElements(elements: Element[]): PreviewElement[] {
  if (!Array.isArray(elements) || elements.length === 0) return [];
  const boxes = elements.map(extent);
  const tolerance = sceneSize(boxes) / PREVIEW_DETAIL;

  let kept = elements.map((element, index) => ({ element, index, box: boxes[index] }));
  if (kept.length > MAX_PREVIEW_ELEMENTS) {
    // The biggest elements shape what a thumbnail looks like; keep them, in their original order.
    const size = ({ box }: { box: Box | null }) => (box ? Math.max(box.maxX - box.minX, box.maxY - box.minY) : 0);
    kept = kept
      .sort((a, b) => size(b) - size(a))
      .slice(0, MAX_PREVIEW_ELEMENTS)
      .sort((a, b) => a.index - b.index);
  }
  // slim only drops stamps and shortens text, so a stroke is still a stroke afterwards, which its loose type can't say.
  return kept.map(({ element }) =>
    element.type === "pen" ? previewStroke(slim(element) as PenElement, tolerance) : slim(element),
  );
}

// Previews of saved boards, kept until the board changes (every save moves
// `updatedAt`), and the longest unused go first once there are too many or they
// take too much memory. Open boards change constantly, so theirs are kept per version of
// the in-memory element list instead. Tests lower these.
export const PREVIEW_CACHE_LIMITS = { entries: 5000, bytes: 20_000_000 };
const saved = new Map<string, { updatedAt: number | undefined; preview: PreviewElement[]; bytes: number }>(); // boardId -> { updatedAt, preview, bytes }, oldest first
let savedBytes = 0;
const live = new WeakMap<Element[], PreviewElement[]>(); // an open board's elements array -> preview

function forget(boardId: string) {
  savedBytes -= saved.get(boardId)?.bytes ?? 0;
  saved.delete(boardId);
}

function remember(boardId: string, updatedAt: number | undefined, preview: PreviewElement[]) {
  forget(boardId);
  // JSON's length stands in for the memory the preview takes.
  const bytes = JSON.stringify(preview).length;
  saved.set(boardId, { updatedAt, preview, bytes });
  savedBytes += bytes;
  while (saved.size > 1 && (saved.size > PREVIEW_CACHE_LIMITS.entries || savedBytes > PREVIEW_CACHE_LIMITS.bytes)) {
    // The loop runs only while the cache holds more than one preview.
    forget(saved.keys().next().value!);
  }
}

/** How many saved boards' previews are cached, and about how many bytes they take. */
export const previewCacheSize = () => ({ entries: saved.size, bytes: savedBytes });

/**
 * Previews for `boards` (loaded without their elements), as a Map from board id.
 * Only boards whose preview isn't cached are read in full, one at a time.
 */
export async function boardPreviews(boards: Pick<BoardDoc, "id" | "_id" | "updatedAt">[]) {
  const previews = new Map<string, PreviewElement[]>();
  const missing: Types.ObjectId[] = [];
  for (const board of boards) {
    const elements: Element[] | undefined = getSession(board.id)?.elements;
    if (elements) {
      if (!live.has(elements)) live.set(elements, previewElements(elements));
      // Set just above if it wasn't there.
      previews.set(board.id, live.get(elements)!);
      continue;
    }
    const cached = saved.get(board.id);
    if (cached && cached.updatedAt === board.updatedAt?.getTime()) {
      previews.set(board.id, cached.preview);
      // Used just now, so it goes to the back of the line for eviction.
      saved.delete(board.id);
      saved.set(board.id, cached);
    } else missing.push(board._id);
  }

  if (missing.length > 0) {
    const cursor = Board.collection.find<{ _id: Types.ObjectId; elements: Element[]; updatedAt?: Date }>(
      { _id: { $in: missing } },
      { projection: { elements: 1, updatedAt: 1 } },
    );
    for await (const doc of cursor) {
      const preview = previewElements(doc.elements);
      remember(String(doc._id), doc.updatedAt?.getTime(), preview);
      previews.set(String(doc._id), preview);
    }
  }
  return previews;
}
