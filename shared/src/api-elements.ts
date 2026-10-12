import { cleanElement } from "./element-rules.ts";
import type { Element } from "./types.ts";

/**
 * An element as the public API and the MCP server show and take it (see docs/api.md): a box is `x`, `y`, `width`
 * and `height`, a line or arrow its two ends (`x1`…`y2`) and what they're attached to (`from`, `to`), and a pen
 * stroke its `points`. The rest are the element's own fields: `text`, `name` (a frame's), `stroke`, `fill`, and so on.
 * What only the app needs (its place in the stack, the merge stamps, the sketchy seed) is left out.
 */
export type ApiElement = { id: string; type: string; [field: string]: unknown };

const BOX_TYPES = new Set(["rectangle", "ellipse", "sticky", "frame", "image"]);
const CONNECTORS = new Set(["line", "arrow"]);
// Left out of what the API shows: the app's bookkeeping, and fields shown another way.
const HIDDEN = new Set(["index", "version", "versionNonce", "stamps", "seed", "startId", "endId", "points"]);
const HIDDEN_BOX = new Set(["x1", "y1", "x2", "y2"]);

export const MAX_API_ELEMENTS = 500;

/** Why an element in the API's form can't be one, in a sentence for whoever sent it. */
export class ApiElementError extends Error {}

// Web Crypto, which browsers and Node both have: this runs on the server (the API) and in the app (drawing with AI).
// The shared code loads neither's types, so the one function used is declared here.
declare const crypto: { getRandomValues<T extends Uint32Array>(array: T): T };
const randomWords = (count: number) => crypto.getRandomValues(new Uint32Array(count));
const newId = () => [...randomWords(3)].map((word) => word.toString(36)).join("");
const newSeed = () => (randomWords(1)[0] % 2 ** 31) + 1;

/** `element` as the API shows it. */
export function toApiElement(element: Element): ApiElement {
  const shown: ApiElement = { id: element.id, type: element.type };
  const fields = element as unknown as Record<string, unknown>;
  for (const [key, value] of Object.entries(fields)) {
    if (HIDDEN.has(key) || (BOX_TYPES.has(element.type) && HIDDEN_BOX.has(key))) continue;
    if (key !== "id" && key !== "type") shown[key] = value;
  }
  if (BOX_TYPES.has(element.type)) {
    const { x1, y1, x2, y2 } = fields as { x1: number; y1: number; x2: number; y2: number };
    Object.assign(shown, {
      x: Math.min(x1, x2),
      y: Math.min(y1, y2),
      width: Math.abs(x2 - x1),
      height: Math.abs(y2 - y1),
    });
  } else if (element.type === "text") {
    Object.assign(shown, { x: element.x1, y: element.y1 });
    delete shown.x1;
    delete shown.y1;
  } else if (element.type === "pen") {
    shown.points = element.points.map(([x, y]) => [x, y]);
  }
  if (CONNECTORS.has(element.type)) {
    if (fields.startId) shown.from = fields.startId;
    if (fields.endId) shown.to = fields.endId;
  }
  return shown;
}

const number = (value: unknown) => (typeof value === "number" && Number.isFinite(value) ? value : undefined);

// The middle of an element, for a line or arrow attached to it that wasn't given where its ends are.
function middleOf(element: Element | undefined): [number, number] | undefined {
  if (!element) return undefined;
  if (element.type === "pen") return element.points[0] && [element.points[0][0], element.points[0][1]];
  if (element.type === "text") return [element.x1, element.y1];
  return [(element.x1 + element.x2) / 2, (element.y1 + element.y2) / 2];
}

/**
 * The element `input` (in the API's form) makes: a new one, or `existing` with what `input` changes. It's whole and
 * unstamped, so the board takes it as the newest edit (see prepareOperation). `find` looks up what a line or arrow
 * is attached to. Throws an ApiElementError naming `label` when the input can't be an element.
 */
export function fromApiElement(
  input: unknown,
  existing: Element | undefined,
  find: (id: string) => Element | undefined,
  label: string,
): Element {
  const fail = (why: string): never => {
    throw new ApiElementError(`${label}: ${why}`);
  };
  if (!input || typeof input !== "object" || Array.isArray(input)) fail("send an object.");
  // Stamps sent along are left out too: a change through the API is always the newest edit.
  const {
    id,
    type,
    x,
    y,
    width,
    height,
    from,
    to,
    points,
    version: _v,
    versionNonce: _n,
    stamps: _s,
    ...rest
  } = input as Record<string, unknown>;
  if (existing && type !== undefined && type !== existing.type) fail(`it's a ${existing.type}; its type can't change.`);
  const kind = existing?.type ?? type;
  if (typeof kind !== "string") fail("say what `type` of element it is.");

  // The element as it is, without its stamps, so the change is stamped as the newest edit of all of it.
  const {
    version: _version,
    versionNonce: _nonce,
    stamps: _stamps,
    ...base
  } = (existing ?? {}) as Record<string, unknown>;
  const element: Record<string, unknown> = {
    ...base,
    ...rest,
    id: existing?.id ?? (typeof id === "string" && id ? id : newId()),
    type: kind,
  };
  if (kind === "rectangle" || kind === "ellipse" || CONNECTORS.has(kind as string)) {
    element.seed ??= newSeed();
  }
  if (kind === "sticky") element.text ??= "";

  if (BOX_TYPES.has(kind as string) && [x, y, width, height].some((value) => value !== undefined)) {
    const was = existing as { x1: number; y1: number; x2: number; y2: number } | undefined;
    const left = number(x) ?? (was && Math.min(was.x1, was.x2));
    const top = number(y) ?? (was && Math.min(was.y1, was.y2));
    const wide = number(width) ?? (was ? Math.abs(was.x2 - was.x1) : undefined);
    const tall = number(height) ?? (was ? Math.abs(was.y2 - was.y1) : undefined);
    if ([left, top, wide, tall].some((value) => value === undefined)) fail("give `x`, `y`, `width` and `height`.");
    Object.assign(element, { x1: left, y1: top, x2: left! + wide!, y2: top! + tall! });
  } else if (kind === "text" && (x !== undefined || y !== undefined)) {
    element.x1 = number(x) ?? element.x1;
    element.y1 = number(y) ?? element.y1;
  } else if (kind === "pen" && points !== undefined) {
    if (!Array.isArray(points)) fail("give `points` as [[x, y], …].");
    element.points = (points as unknown[]).map((point) => (Array.isArray(point) ? [point[0], point[1], 0.5] : point));
  }

  if (CONNECTORS.has(kind as string)) {
    if (from !== undefined) element.startId = from;
    if (to !== undefined) element.endId = to;
    // Attached ends are drawn from what they're attached to; until then they start at its middle.
    for (const [end, xKey, yKey] of [
      ["startId", "x1", "y1"],
      ["endId", "x2", "y2"],
    ] as const) {
      if (number(element[xKey]) !== undefined && number(element[yKey]) !== undefined) continue;
      const middle = typeof element[end] === "string" ? middleOf(find(element[end] as string)) : undefined;
      if (!middle) fail(`give \`${xKey}\` and \`${yKey}\`, or what it starts or ends on (\`from\`, \`to\`).`);
      [element[xKey], element[yKey]] = middle!;
    }
  }

  const clean = cleanElement(element);
  if (!clean) fail("it's missing something its type needs, or has a value that's out of range. See docs/api.md.");
  return clean!;
}
