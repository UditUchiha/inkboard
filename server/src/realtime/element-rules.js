import { cleanStamps, groupStamps, withStamps } from "@inkboard/shared/board-merge";
import { isOrderKey } from "@inkboard/shared/board-order";
import { IMAGE_ID } from "../services/image-storage.js";

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

const SHAPE_TYPES = new Set(["line", "arrow", "rectangle", "ellipse"]);
const FILLABLE_TYPES = new Set(["rectangle", "ellipse"]);
const TURNABLE_TYPES = new Set(["rectangle", "ellipse", "image", "pen", "text"]);
const FONTS = new Set(["hand", "sans", "code"]);
const COLOR = /^#(?:[0-9a-f]{3}|[0-9a-f]{6}|[0-9a-f]{8})$/i;

const DEFAULTS = { stroke: "#16213a", strokeWidth: 2.5, penSize: 8, fontSize: 32, font: "hand", pressure: 0.5 };
// The client's own ranges, with room to spare where resizing can grow things.
const RANGES = { strokeWidth: [0.1, 100], penSize: [0.5, 200], fontSize: [8, 400] };

export const isValidId = (id) => typeof id === "string" && id.length > 0 && id.length <= 64;
const isCoordinate = (value) => typeof value === "number" && Number.isFinite(value) && Math.abs(value) <= COORDINATE_LIMIT;
const isPlainObject = (value) => value !== null && typeof value === "object" && !Array.isArray(value);

const color = (value, fallback) => (typeof value === "string" && COLOR.test(value) ? value : fallback);
const inRange = (value, [min, max], fallback) =>
  typeof value === "number" && Number.isFinite(value) ? Math.min(max, Math.max(min, value)) : fallback;

// A stroke's points, keeping only well-formed ones; null if none are.
function cleanPoints(points) {
  if (!Array.isArray(points)) return null;
  const clean = [];
  for (const point of points) {
    if (!Array.isArray(point) || !isCoordinate(point[0]) || !isCoordinate(point[1])) continue;
    clean.push([point[0], point[1], inRange(point[2], [0, 1], DEFAULTS.pressure)]);
  }
  return clean.length > 0 ? clean : null;
}

const corner = (element) => isCoordinate(element.x1) && isCoordinate(element.y1);
const box = (element) => corner(element) && isCoordinate(element.x2) && isCoordinate(element.y2);

function cleanByType(element) {
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
  if (type === "image") {
    if (!IMAGE_ID.test(element.imageId) || !box(element)) return null;
    const { imageId, x1, y1, x2, y2 } = element;
    return { id, type, imageId, x1, y1, x2, y2 };
  }
  if (SHAPE_TYPES.has(type)) {
    if (!box(element)) return null;
    const { x1, y1, x2, y2 } = element;
    return {
      id,
      type,
      // Rough.js draws the same wobble for the same seed, so everyone sees the same shape.
      seed: Number.isInteger(element.seed) && element.seed >= 1 && element.seed <= 2 ** 31 ? element.seed : 1,
      x1,
      y1,
      x2,
      y2,
      stroke: color(element.stroke, DEFAULTS.stroke),
      fill: FILLABLE_TYPES.has(type) ? color(element.fill, null) : null,
      strokeWidth: inRange(element.strokeWidth, RANGES.strokeWidth, DEFAULTS.strokeWidth),
      sketchy: element.sketchy !== false,
    };
  }
  return null;
}

/** The element as the board may store it, or null if it can't be stored at all. */
export function cleanElement(element) {
  if (!isPlainObject(element) || !isValidId(element.id)) return null;
  const clean = cleanByType(element);
  if (!clean) return null;
  if (TURNABLE_TYPES.has(clean.type) && typeof element.angle === "number" && Number.isFinite(element.angle)) {
    clean.angle = element.angle;
  }
  // Where it sits in the stack (see shared/src/board-order.js).
  if (isOrderKey(element.index)) clean.index = element.index;
  // Which edit of the element, and of each group of its properties, this is
  // (see shared/src/board-merge.js). Brought into shape: `version` is the newest
  // stamp and `stamps` lists only older ones.
  if (Number.isSafeInteger(element.version) && element.version >= 0) {
    clean.version = element.version;
    if (Number.isInteger(element.versionNonce) && element.versionNonce >= 0 && element.versionNonce < 2 ** 31) {
      clean.versionNonce = element.versionNonce;
    }
    const stamps = cleanStamps(element.stamps);
    if (stamps) clean.stamps = stamps;
    return withStamps(clean, groupStamps(clean));
  }
  return clean;
}
