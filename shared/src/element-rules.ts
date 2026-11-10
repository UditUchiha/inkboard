import { cleanStamps, groupStamps, isNonce, isVersion, withStamps } from "./board-merge.ts";
import { isOrderKey } from "./board-order.ts";
import { MAX_ALT_LENGTH, MAX_FRAME_NAME_LENGTH, MAX_TEXT_LENGTH } from "./limits.ts";
import type {
  ConnectorFields,
  Element,
  FieldGroup,
  Fields,
  Font,
  ImageCrop,
  Point,
  Route,
  ShapeElement,
  Side,
  TurnableType,
} from "./types.ts";

// Elements come from anyone who can edit a board, guests on an edit link included, so nothing is trusted. What an
// element *is*
// (id, type, geometry, points, text, image id) must be right or it's refused; how it *looks* is forgiven (a bad color,
// width or font is replaced or brought into range, so older saved elements stay editable); unknown fields are dropped.

export const COORDINATE_LIMIT = 10_000_000; // far beyond any real drawing
export { MAX_ALT_LENGTH, MAX_FRAME_NAME_LENGTH, MAX_TEXT_LENGTH };
// The smallest part of a picture a crop can keep, as a fraction of its side.
const MIN_CROP = 0.001;
// refused before anything is done with it; MAX_ELEMENT_BYTES on the server allows about 11,000, so this only stops
// absurd ones
export const MAX_STROKE_POINTS = 50_000;
export const IMAGE_ID = /^[a-f0-9]{32}$/;

// a Set<string> can only say yes or no; this also tells TypeScript what a member is (each set holds exactly the values
// of its type)
type Choices<T extends string> = { has(value: unknown): value is T };

const SHAPE_TYPES = new Set(["line", "arrow", "rectangle", "ellipse", "triangle", "diamond"]) as unknown as Choices<
  ShapeElement["type"]
>;
const CONNECTOR_TYPES = new Set(["line", "arrow"]);
const FILLABLE_TYPES = new Set(["rectangle", "ellipse", "triangle", "diamond"]);
const TURNABLE_TYPES = new Set([
  "rectangle",
  "ellipse",
  "triangle",
  "diamond",
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

type Range = readonly [min: number, max: number];
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

// made when first needed: a browser without Intl.Segmenter (Firefox before 125) must still open this module; those cut
// between code points, which may split an emoji sequence
let graphemes: Intl.Segmenter | null | undefined;
const segmentsOf = (text: string): string[] => {
  if (graphemes === undefined) graphemes = typeof Intl.Segmenter === "function" ? new Intl.Segmenter() : null;
  return graphemes ? Array.from(graphemes.segment(text), ({ segment }) => segment) : Array.from(text);
};

// never in the middle of a letter with its accents, an emoji or anything else drawn as one; looks only a little past
// `max`, so it costs the same for any length
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

function cleanPoints(points: unknown): Point[] | null {
  if (!Array.isArray(points) || points.length > MAX_STROKE_POINTS) return null;
  const clean: Point[] = [];
  for (const point of points) {
    if (!Array.isArray(point) || !isCoordinate(point[0]) || !isCoordinate(point[1])) continue;
    clean.push([point[0], point[1], inRange(point[2], [0, 1], DEFAULTS.pressure)]);
  }
  return clean.length > 0 ? clean : null;
}

// defaults a line or arrow has from the start (see createElement in the client); each is a property group of its own
const CONNECTOR_DEFAULTS: { text: string; route: Route; font: Font } = {
  text: "",
  route: "straight",
  font: DEFAULTS.font,
};
const ARROW_DEFAULTS = { ...CONNECTOR_DEFAULTS, startHead: false };

// version 0, older than any edit, so whatever anyone actually set wins over it
const UNSET = { version: 0, versionNonce: 0 };

// Lines and arrows saved before they had every field get defaults, stamped as never set. A copy lacking a group has no
// say
// in a merge (see mergeElement), so without this undoing a label on an old arrow couldn't be said and the label would
// stay.
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
    if (stamps) stamps[field as FieldGroup] = UNSET;
  }
  return stamps ? withStamps(filled, stamps) : (filled as Element);
}

const corner = (element: Fields): element is Fields & { x1: number; y1: number } =>
  isCoordinate(element.x1) && isCoordinate(element.y1);
const box = (element: Fields): element is Fields & { x1: number; y1: number; x2: number; y2: number } =>
  corner(element) && isCoordinate(element.x2) && isCoordinate(element.y2);

// Both ends can't attach to the same element (the line would be a dot or double back): the second attachment is left
// out.
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

// a crop that isn't inside the picture, or is too small to see, is dropped, which shows the whole picture
function cleanCrop(value: unknown): ImageCrop | undefined {
  if (!value || typeof value !== "object") return undefined;
  const { x, y, w, h } = value as Record<string, unknown>;
  const fraction = (part: unknown): part is number => typeof part === "number" && part >= 0 && part <= 1;
  if (!fraction(x) || !fraction(y) || !fraction(w) || !fraction(h) || w < MIN_CROP || h < MIN_CROP) return undefined;
  if (x + w > 1 + 1e-6 || y + h > 1 + 1e-6) return undefined;
  return { x, y, w: Math.min(w, 1 - x), h: Math.min(h, 1 - y) };
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
    // the type is checked first because the pattern coerces its input: an array holding a valid id would pass, and the
    // server's search for pictures in use would miss it
    const imageId = element.imageId;
    if (typeof imageId !== "string" || !IMAGE_ID.test(imageId) || !box(element)) return null;
    const { x1, y1, x2, y2 } = element;
    const crop = cleanCrop(element.crop);
    return {
      id,
      type,
      imageId,
      x1,
      y1,
      x2,
      y2,
      ...(crop && { crop }),
      // Kept when empty: that is how a description is cleared (see mergeElements in board-merge.ts).
      ...(typeof element.alt === "string" && { alt: cutText(element.alt, MAX_ALT_LENGTH) }),
    };
  }
  if (SHAPE_TYPES.has(type)) {
    if (!box(element)) return null;
    const { x1, y1, x2, y2 } = element;
    return {
      id,
      type,
      // the same seed draws the same wobble everywhere, so everyone sees the same shape
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

export function cleanElement(element: unknown): Element | null {
  if (!isPlainObject(element) || !isValidId(element.id)) return null;
  const clean = cleanByType(element as Fields);
  if (!clean) return null;
  if (TURNABLE_TYPES.has(clean.type) && typeof element.angle === "number" && Number.isFinite(element.angle)) {
    (clean as { angle?: number }).angle = element.angle;
  }
  if (isOrderKey(element.index)) clean.index = element.index;
  // `version` is the newest stamp and `stamps` lists only older ones; an invalid one (past MAX_VERSION, say) is dropped
  // and the change is stamped as the newest edit
  if (isVersion(element.version)) {
    clean.version = element.version;
    if (isNonce(element.versionNonce)) clean.versionNonce = element.versionNonce;
    const stamps = cleanStamps(element.stamps);
    if (stamps) clean.stamps = stamps;
    return withDefaults(withStamps(clean, groupStamps(clean)));
  }
  return withDefaults(clean);
}
