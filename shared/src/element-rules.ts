import { cleanStamps, groupStamps, isNonce, isVersion, withStamps } from "./board-merge.ts";
import { isOrderKey } from "./board-order.ts";
import type {
  ConnectorFields,
  Element,
  FieldGroup,
  Fields,
  Font,
  Point,
  Route,
  ShapeElement,
  Side,
  TurnableType,
} from "./types.ts";

// What each kind of element may contain, matching what the client creates (see
// client/src/features/board/elements.js). Elements arrive from anyone who can
// edit a board, including guests on an edit link, so nothing is trusted:
//
// - What an element *is* must be right: its id, type and geometry, a pen
//   stroke's points, a text's text, a picture's image id. If not, it's refused.
// - How it *looks* is forgiven: a color, width, size or font that's missing or
//   odd is replaced by the default or brought into range, so an element saved
//   by an older version of the app can still be edited.
// - Fields the app doesn't use are dropped.

export const COORDINATE_LIMIT = 10_000_000; // far beyond any real drawing
export const MAX_TEXT_LENGTH = 20_000;
export const MAX_FRAME_NAME_LENGTH = 200;
// A stroke past this is refused before anything is done with it. About what fits in an
// element (MAX_ELEMENT_BYTES on the server allows about 11,000), so this only stops absurd ones.
export const MAX_STROKE_POINTS = 50_000;
export const IMAGE_ID = /^[a-f0-9]{32}$/;

// A fixed set of strings that also tells TypeScript what a member is: a plain Set<string> can only say yes or
// no. The casts below are safe because each of those sets holds exactly the values of the type it names.
type Choices<T extends string> = { has(value: unknown): value is T };

const SHAPE_TYPES = new Set(["line", "arrow", "rectangle", "ellipse"]) as unknown as Choices<ShapeElement["type"]>;
const CONNECTOR_TYPES = new Set(["line", "arrow"]);
const FILLABLE_TYPES = new Set(["rectangle", "ellipse"]);
const TURNABLE_TYPES = new Set([
  "rectangle",
  "ellipse",
  "image",
  "pen",
  "text",
  "sticky",
]) as unknown as Choices<TurnableType>;
const FONTS = new Set(["hand", "sans", "code"]) as unknown as Choices<Font>;
const SIDES = new Set(["top", "right", "bottom", "left"]) as unknown as Choices<Side>;
const ROUTES = new Set(["straight", "curved", "elbow"]) as unknown as Choices<Route>;
const COLOR = /^#(?:[0-9a-f]{3}|[0-9a-f]{6}|[0-9a-f]{8})$/i;

const DEFAULTS: {
  stroke: string;
  strokeWidth: number;
  penSize: number;
  fontSize: number;
  font: Font;
  pressure: number;
  noteFill: string;
} = {
  stroke: "#16213a",
  strokeWidth: 2.5,
  penSize: 8,
  fontSize: 32,
  font: "hand",
  pressure: 0.5,
  noteFill: "#ffec99",
};

// A lowest and a highest value.
type Range = readonly [min: number, max: number];
// The client's own ranges, with room to spare where resizing can grow things.
const RANGES: { strokeWidth: Range; penSize: Range; fontSize: Range } = {
  strokeWidth: [0.1, 100],
  penSize: [0.5, 200],
  fontSize: [8, 400],
};

export const isValidId = (id: unknown): id is string => typeof id === "string" && id.length > 0 && id.length <= 64;
const isCoordinate = (value: unknown): value is number =>
  typeof value === "number" && Number.isFinite(value) && Math.abs(value) <= COORDINATE_LIMIT;
const isPlainObject = (value: unknown): value is Record<string, unknown> =>
  value !== null && typeof value === "object" && !Array.isArray(value);

// Made when first needed: this module is loaded with the editor, and a browser without
// Intl.Segmenter (Firefox before 125) must still open it. Those cut between code points
// instead, which keeps surrogate pairs whole but may split an emoji sequence.
let graphemes: Intl.Segmenter | null | undefined;
const segmentsOf = (text: string): string[] => {
  if (graphemes === undefined) graphemes = typeof Intl.Segmenter === "function" ? new Intl.Segmenter() : null;
  return graphemes ? Array.from(graphemes.segment(text), ({ segment }) => segment) : Array.from(text);
};

/**
 * `text` cut to at most `max` characters (UTF-16 units, as `.length` counts), never in the
 * middle of a letter with its accents, an emoji (a ZWJ sequence, a flag, a surrogate pair)
 * or anything else that's drawn as one. Looks only a little past `max`, so it costs the same for any length.
 */
export function cutText(text: string, max: number): string {
  if (text.length <= max) return text;
  let end = 0;
  for (const segment of segmentsOf(text.slice(0, max + 64))) {
    if (end + segment.length > max) break;
    end += segment.length;
  }
  return text.slice(0, end);
}

const color = <F extends string | null>(value: unknown, fallback: F): string | F =>
  typeof value === "string" && COLOR.test(value) ? value : fallback;
const inRange = (value: unknown, [min, max]: Range, fallback: number): number =>
  typeof value === "number" && Number.isFinite(value) ? Math.min(max, Math.max(min, value)) : fallback;

// A stroke's points, keeping only well-formed ones; null if none are.
function cleanPoints(points: unknown): Point[] | null {
  if (!Array.isArray(points) || points.length > MAX_STROKE_POINTS) return null;
  const clean: Point[] = [];
  for (const point of points) {
    if (!Array.isArray(point) || !isCoordinate(point[0]) || !isCoordinate(point[1])) continue;
    clean.push([point[0], point[1], inRange(point[2], [0, 1], DEFAULTS.pressure)]);
  }
  return clean.length > 0 ? clean : null;
}

// What a line or arrow has from the start (see createElement in client/src/features/board/elements.js):
// a label (empty), a route, the label's font, and for an arrow, whether it has a head at the start. Each
// is a property group of its own (see FIELD_GROUPS in board-merge.js).
const CONNECTOR_DEFAULTS: { text: string; route: Route; font: Font } = {
  text: "",
  route: "straight",
  font: DEFAULTS.font,
};
const ARROW_DEFAULTS = { ...CONNECTOR_DEFAULTS, startHead: false };

// The stamp of a field filled in with its default: version 0, older than any edit (each is stamped
// 1 or more), so whatever anyone actually set wins over it, and it wins over nothing.
const UNSET = { version: 0, versionNonce: 0 };

/**
 * `element` with every field its kind always has, or `element` itself when none is missing. Lines and
 * arrows saved before they all had a label, a route, a label font and (arrows) a start arrowhead get the
 * defaults, stamped as never set. A copy that lacks a group has no say in it when copies are merged
 * (see mergeElement), so without this, putting one of those back to how it was (undoing a label on an
 * old arrow) couldn't be said, and the label would stay. Boards fill them in wherever elements arrive.
 */
export function withDefaults(element: Element): Element {
  const defaults: Record<string, string | boolean> | null =
    element?.type === "arrow" ? ARROW_DEFAULTS : element?.type === "line" ? CONNECTOR_DEFAULTS : null;
  if (!defaults) return element;
  const missing = Object.keys(defaults).filter((field) => !(field in element));
  if (missing.length === 0) return element;
  const stamps = isVersion(element.version) ? groupStamps(element) : null;
  const filled: Fields = { ...element };
  for (const field of missing) {
    filled[field] = defaults[field];
    // Each field filled in is a property group of its own (see FIELD_GROUPS in board-merge.ts).
    if (stamps) stamps[field as FieldGroup] = UNSET;
  }
  // `filled` is `element` plus the fields that were missing, which the types can't follow through the loop.
  return stamps ? withStamps(filled, stamps) : (filled as Element);
}

const corner = (element: Fields): element is Fields & { x1: number; y1: number } =>
  isCoordinate(element.x1) && isCoordinate(element.y1);
const box = (element: Fields): element is Fields & { x1: number; y1: number; x2: number; y2: number } =>
  corner(element) && isCoordinate(element.x2) && isCoordinate(element.y2);

// What a line or arrow has beyond its shape (see client/src/features/board/connectors.js and routes.js):
// the elements its ends are attached to (one that's missing later is ignored when drawing), and the
// side of each it's pinned to; its route; an arrowhead at the start; a label and the label's font.
// Both ends can't be attached to the same element (the line would be a dot, or double back on
// itself): the second attachment is left out.
function connectorFields(element: Fields): ConnectorFields {
  const kept: ConnectorFields = {};
  for (const [key, side] of [
    ["startId", "startAnchor"],
    ["endId", "endAnchor"],
  ] as const) {
    if (!isValidId(element[key]) || element[key] === element.id) continue;
    if (key === "endId" && element.endId === element.startId) continue;
    kept[key] = element[key];
    if (SIDES.has(element[side])) kept[side] = element[side];
  }
  if (ROUTES.has(element.route)) kept.route = element.route;
  if (element.type === "arrow" && typeof element.startHead === "boolean") kept.startHead = element.startHead;
  if (typeof element.text === "string") kept.text = cutText(element.text, MAX_TEXT_LENGTH);
  if (FONTS.has(element.font)) kept.font = element.font;
  return kept;
}

function cleanByType(element: Fields): Element | null {
  const { id, type } = element;
  if (type === "pen") {
    const points = cleanPoints(element.points);
    if (!points) return null;
    return {
      id,
      type,
      points,
      pressure: element.pressure === true,
      stroke: color(element.stroke, DEFAULTS.stroke),
      penSize: inRange(element.penSize, RANGES.penSize, DEFAULTS.penSize),
    };
  }
  if (type === "text") {
    if (!corner(element) || typeof element.text !== "string" || element.text.length > MAX_TEXT_LENGTH) return null;
    return {
      id,
      type,
      x1: element.x1,
      y1: element.y1,
      text: element.text,
      stroke: color(element.stroke, DEFAULTS.stroke),
      fontSize: inRange(element.fontSize, RANGES.fontSize, DEFAULTS.fontSize),
      font: FONTS.has(element.font) ? element.font : DEFAULTS.font,
    };
  }
  if (type === "sticky") {
    if (!box(element) || typeof element.text !== "string" || element.text.length > MAX_TEXT_LENGTH) return null;
    const { x1, y1, x2, y2 } = element;
    return {
      id,
      type,
      x1,
      y1,
      x2,
      y2,
      text: element.text,
      fill: color(element.fill, DEFAULTS.noteFill),
      font: FONTS.has(element.font) ? element.font : DEFAULTS.font,
    };
  }
  if (type === "frame") {
    if (!box(element)) return null;
    const { x1, y1, x2, y2 } = element;
    const name = typeof element.name === "string" ? cutText(element.name, MAX_FRAME_NAME_LENGTH) : "";
    return { id, type, x1, y1, x2, y2, name };
  }
  if (type === "image") {
    // The test turns `imageId` into a string before matching it, so passing doesn't prove that it is one (an
    // array holding a matching string passes too). Both casts only describe what is checked here.
    if (!IMAGE_ID.test(element.imageId as string) || !box(element)) return null;
    const { imageId, x1, y1, x2, y2 } = element as typeof element & { imageId: string };
    return { id, type, imageId, x1, y1, x2, y2 };
  }
  if (SHAPE_TYPES.has(type)) {
    if (!box(element)) return null;
    const { x1, y1, x2, y2 } = element;
    return {
      id,
      type,
      // Rough.js draws the same wobble for the same seed, so everyone sees the same shape.
      // Number.isInteger only returns a boolean, so TypeScript doesn't learn from it that `seed` is a number.
      seed:
        Number.isInteger(element.seed) && (element.seed as number) >= 1 && (element.seed as number) <= 2 ** 31
          ? (element.seed as number)
          : 1,
      x1,
      y1,
      x2,
      y2,
      stroke: color(element.stroke, DEFAULTS.stroke),
      fill: FILLABLE_TYPES.has(type) ? color(element.fill, null) : null,
      strokeWidth: inRange(element.strokeWidth, RANGES.strokeWidth, DEFAULTS.strokeWidth),
      sketchy: element.sketchy !== false,
      ...(CONNECTOR_TYPES.has(type) ? connectorFields(element) : {}),
    };
  }
  return null;
}

/** The element as the board may store it, or null if it can't be stored at all. */
export function cleanElement(element: unknown): Element | null {
  if (!isPlainObject(element) || !isValidId(element.id)) return null;
  // `isValidId` checked `element.id`, but narrowing a property doesn't narrow the object it belongs to.
  const clean = cleanByType(element as Fields);
  if (!clean) return null;
  if (TURNABLE_TYPES.has(clean.type) && typeof element.angle === "number" && Number.isFinite(element.angle)) {
    // TURNABLE_TYPES says which types may have an angle, but only for `clean.type`, not for `clean` itself.
    (clean as { angle?: number }).angle = element.angle;
  }
  // Where it sits in the stack (see shared/src/board-order.js).
  if (isOrderKey(element.index)) clean.index = element.index;
  // Which edit of the element, and of each group of its properties, this is
  // (see shared/src/board-merge.js). Brought into shape: `version` is the newest
  // stamp and `stamps` lists only older ones. One that isn't a version (past
  // MAX_VERSION, say) is dropped, and the change is stamped as the newest edit.
  if (isVersion(element.version)) {
    clean.version = element.version;
    if (isNonce(element.versionNonce)) clean.versionNonce = element.versionNonce;
    const stamps = cleanStamps(element.stamps);
    if (stamps) clean.stamps = stamps;
    return withDefaults(withStamps(clean, groupStamps(clean)));
  }
  return withDefaults(clean);
}
