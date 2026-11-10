import type {
  Element as BoardElement,
  FrameElement,
  ImageElement,
  PenElement,
  ShapeElement,
  Side,
  StickyElement,
} from "@inkboard/shared/types";
import getStroke from "perfect-freehand";
import rough from "roughjs";
import type { RoughCanvas } from "roughjs/bin/canvas";
import type { Drawable, Options, PathInfo } from "roughjs/bin/core";
import { createDrawingCache } from "./drawCache";
import type { Moved } from "./drawCache";
import { connectionDots, forgetResolvedConnectors, isConnector, resolveConnectors } from "../elements/connectors";
import { FRAME_BORDER, FRAME_FILL, FRAME_LABEL_COLOR, LINE_HEIGHT, NOTE_TEXT_COLOR } from "../../constants/board";
import {
  arrowHeads,
  canRotate,
  connectorLabel,
  fontFor,
  forgetBounds,
  forgetConnectorLabels,
  forgetFrameLabels,
  frameLabel,
  frameLabelBox,
  getBounds,
  getFrame,
  getLocalBounds,
  inDrawOrder,
  isFrame,
} from "../elements/elements";
import type { AnyElement, Connector } from "../elements/elements";
import { expandRect, normalizeRect, polygonCorners, rectCenter, rectsOverlap, unionRects } from "../elements/geometry";
import type { Rect, Viewport } from "../elements/geometry";
import { getImage, imagesVersion, picturesChanged, releaseImages, showingImages } from "../files/images";
import { darkInk } from "./ink";
import { formulaOf, formulaPicture, onFormulasChanged } from "../elements/math";
import { forgetNoteMeasurements, noteLayout } from "../elements/notes";
import { connectorPath, pathData } from "../elements/routes";
import type { SuggestionMark } from "../sync/suggestions";
import { getSelectionBox } from "../elements/transform";
import { GUTTER, MAX_TILES, TILE, drawsFromTiles, tileCount } from "./zoomedOutCache";
import type { TileCache } from "./zoomedOutCache";

type Ink = (color: string) => string;

export type RenderOptions = {
  elements: BoardElement[];
  viewport: Viewport;
  dpr?: number;
  selectedId?: string | null;
  hiddenId?: string | null;
  croppingId?: string | null;
  background?: string | null;
  dark?: boolean;
  smallImages?: boolean;
  screenLabels?: boolean;
  connectTargetId?: string | null;
  dots?: { id: string; side: Side | null } | null;
  suggestions?: readonly SuggestionMark[]; // Classroom mode: who claimed each frame, by its id, shown after its name; this person's own is outlined.
  frameClaims?: ReadonlyMap<string, { name: string; mine: boolean }> | undefined;
  tiles?: TileCache;
};

const generator = rough.generator();

// How the scene being drawn is shown; set by renderScene.
const sameInk: Ink = (color) => color;
let ink: Ink = sameInk;
let smallPictures = false;
let labelScale = 1;
let picturesDrawn = new Set<string>(); // the image ids drawn in the scene being rendered
let croppingId: string | null = null;
let zoomNow = 1; // screen pixels per board unit, in the scene being rendered
let claimsNow: ReadonlyMap<string, { name: string; mine: boolean }> = new Map(); // classroom mode's, see RenderOptions

// Zoomed far out, unseen detail isn't drawn in full: text under READABLE_TEXT screen pixels can't be read, and notes under NOTE_SHADOW_MIN show no shadow.
const READABLE_TEXT = 3;
const NOTE_SHADOW_MIN = 24;
const readable = (fontSize: number) => fontSize * zoomNow >= READABLE_TEXT;

// Under this many screen pixels a sketchy wobble is sub-pixel and Rough.js's several strokes per shape cost the most, so plain paths are used.
const PLAIN_SHAPE_MAX = 40;

// Elements are immutable, so generated shapes are cached per object (and reused for moved copies); light and dark keep separate caches.
const drawableCaches = { light: createDrawingCache<Drawable[]>(), dark: createDrawingCache<Drawable[]>() };
const penPathCache = createDrawingCache<Path2D>();

function roughOptions(element: ShapeElement, paint: Ink): Options {
  const sketchy = element.sketchy !== false;
  return {
    seed: element.seed,
    stroke: paint(element.stroke),
    strokeWidth: element.strokeWidth,
    roughness: sketchy ? 1.1 : 0,
    bowing: sketchy ? 1 : 0,
    disableMultiStroke: !sketchy,
    preserveVertices: !sketchy,
    fill: element.fill ? paint(element.fill) : undefined,
    fillStyle: sketchy ? "hachure" : "solid",
    fillWeight: Math.max(element.strokeWidth / 2, 0.75),
    hachureGap: 4 + element.strokeWidth * 2,
  };
}

function buildDrawables(element: ShapeElement, paint: Ink = ink): Drawable[] {
  const options = roughOptions(element, paint);
  const { x1, y1, x2, y2 } = element;
  switch (element.type) {
    case "line":
    case "arrow": {
      const path = connectorPath(element);
      let body: Drawable;
      if (path.curved) body = generator.path(pathData(path), options);
      else if (path.points.length > 2)
        body = generator.linearPath(
          path.points.map(({ x, y }) => [x, y]),
          options,
        );
      else body = generator.line(x1, y1, x2, y2, options);
      return [body, ...arrowHeads(element).map((head) => generator.linearPath(head, options))];
    }
    case "rectangle": {
      const r = normalizeRect(x1, y1, x2, y2);
      return [generator.rectangle(r.x, r.y, r.width, r.height, options)];
    }
    case "ellipse": {
      const r = normalizeRect(x1, y1, x2, y2);
      if (r.width < 1 || r.height < 1) return [];
      return [generator.ellipse(r.x + r.width / 2, r.y + r.height / 2, r.width, r.height, options)];
    }
    case "triangle":
    case "diamond": {
      return [generator.polygon(polygonCorners(element.type, normalizeRect(x1, y1, x2, y2))!, options)];
    }
    default:
      return [];
  }
}

const average = (a: number, b: number): number => (a + b) / 2;

function svgPathFromOutline(points: number[][]): string {
  if (points.length < 4) return "";
  let [a, b] = points;
  const c = points[2];
  let path = `M${a[0].toFixed(2)},${a[1].toFixed(2)} Q${b[0].toFixed(2)},${b[1].toFixed(2)} ${average(b[0], c[0]).toFixed(2)},${average(b[1], c[1]).toFixed(2)} T`;
  for (let i = 2; i < points.length - 1; i += 1) {
    a = points[i];
    b = points[i + 1];
    path += `${average(a[0], b[0]).toFixed(2)},${average(a[1], b[1]).toFixed(2)} `;
  }
  return `${path}Z`;
}

export function penOutline(element: PenElement): string {
  const outline = getStroke(element.points, {
    size: element.penSize,
    thinning: 0.55,
    smoothing: 0.5,
    streamline: 0.45,
    simulatePressure: !element.pressure,
  });
  return svgPathFromOutline(outline);
}

const penPath = (element: PenElement) =>
  penPathCache.get(element, (stroke) => new Path2D(penOutline(stroke as PenElement)));

function drawMoved({ dx, dy }: Moved, ctx: CanvasRenderingContext2D, draw: () => void) {
  if (!dx && !dy) {
    draw();
    return;
  }
  ctx.save();
  ctx.translate(dx, dy);
  draw();
  ctx.restore();
}

export function shapePaths(element: ShapeElement): PathInfo[] {
  return buildDrawables(element, sameInk).flatMap((drawable) => generator.toPaths(drawable));
}

// `hideLabel` leaves out a connector's label (while it's being edited).
function drawElement(
  ctx: CanvasRenderingContext2D,
  roughCanvas: RoughCanvas,
  element: BoardElement,
  { hideLabel = false }: { hideLabel?: boolean } = {},
) {
  if (isConnector(element)) {
    drawConnector(ctx, roughCanvas, element, hideLabel);
    return;
  }
  if (!canRotate(element) || !element.angle) {
    drawUnturned(ctx, roughCanvas, element);
    return;
  }
  const center = rectCenter(getLocalBounds(element));
  ctx.save();
  ctx.translate(center.x, center.y);
  ctx.rotate(element.angle);
  ctx.translate(-center.x, -center.y);
  drawUnturned(ctx, roughCanvas, element);
  ctx.restore();
}

function drawConnector(
  ctx: CanvasRenderingContext2D,
  roughCanvas: RoughCanvas,
  element: Connector,
  hideLabel: boolean,
) {
  const label = connectorLabel(element);
  if (!label) {
    drawUnturned(ctx, roughCanvas, element);
    return;
  }
  ctx.save();
  const around = expandRect(getBounds(element), 8);
  ctx.beginPath();
  ctx.rect(around.x, around.y, around.width, around.height);
  ctx.rect(label.x, label.y, label.width, label.height);
  ctx.clip("evenodd");
  drawUnturned(ctx, roughCanvas, element);
  ctx.restore();
  if (hideLabel || !readable(label.fontSize)) return;
  ctx.save();
  ctx.font = label.font;
  ctx.fillStyle = ink(element.stroke);
  ctx.textAlign = "center";
  ctx.textBaseline = "top";
  const lineHeight = label.fontSize * LINE_HEIGHT;
  const centerX = label.x + label.width / 2;
  const top = label.y + (label.height - label.lines.length * lineHeight) / 2 + (lineHeight - label.fontSize) / 2;
  label.lines.forEach((line, index) => ctx.fillText(line, centerX, top + index * lineHeight));
  ctx.restore();
}

function drawPicture(ctx: CanvasRenderingContext2D, element: ImageElement) {
  const { image, state } = getImage(element.imageId, { small: smallPictures });
  picturesDrawn.add(element.imageId);
  const { x, y, width, height } = normalizeRect(element.x1, element.y1, element.x2, element.y2);
  ctx.save();
  if (state === "ready") {
    ctx.imageSmoothingQuality = "high";
    const crop = element.crop;
    if (!crop) {
      ctx.drawImage(image, x, y, width, height);
    } else {
      const { naturalWidth: w, naturalHeight: h } = image;
      if (element.id === croppingId) {
        ctx.globalAlpha = 0.3;
        ctx.drawImage(
          image,
          x - (crop.x / crop.w) * width,
          y - (crop.y / crop.h) * height,
          width / crop.w,
          height / crop.h,
        );
        ctx.globalAlpha = 1;
      }
      ctx.drawImage(image, crop.x * w, crop.y * h, crop.w * w, crop.h * h, x, y, width, height);
    }
  } else {
    ctx.fillStyle = ink("rgba(128, 128, 128, 0.12)");
    ctx.strokeStyle = ink("rgba(128, 128, 128, 0.6)");
    ctx.lineWidth = 1.5;
    ctx.setLineDash([6, 5]);
    ctx.fillRect(x, y, width, height);
    ctx.strokeRect(x, y, width, height);
    if (state === "failed") {
      ctx.setLineDash([]);
      ctx.beginPath();
      ctx.moveTo(x, y);
      ctx.lineTo(x + width, y + height);
      ctx.moveTo(x + width, y);
      ctx.lineTo(x, y + height);
      ctx.stroke();
    }
  }
  ctx.restore();
}

// A note casts a soft shadow, sized with the board so it zooms like the note.
function drawNote(ctx: CanvasRenderingContext2D, element: StickyElement) {
  const { x, y, width, height } = normalizeRect(element.x1, element.y1, element.x2, element.y2);
  const transform = ctx.getTransform();
  const pixels = Math.hypot(transform.a, transform.b); // device pixels per board unit
  ctx.save();
  if (Math.min(width, height) * zoomNow >= NOTE_SHADOW_MIN) {
    ctx.shadowColor = "rgba(22, 33, 58, 0.18)";
    ctx.shadowBlur = Math.min(width, height) * 0.05 * pixels;
    ctx.shadowOffsetY = Math.min(width, height) * 0.015 * pixels;
  }
  ctx.fillStyle = ink(element.fill);
  ctx.fillRect(x, y, width, height);
  ctx.restore();

  const layout = noteLayout(element);
  if (!readable(layout.fontSize)) return;
  ctx.save();
  ctx.beginPath();
  ctx.rect(x, y, width, height);
  ctx.clip();
  ctx.font = fontFor({ fontSize: layout.fontSize, font: element.font });
  ctx.fillStyle = ink(NOTE_TEXT_COLOR);
  ctx.textAlign = "center";
  ctx.textBaseline = "top";
  const offset = (layout.lineHeight - layout.fontSize) / 2;
  layout.lines.slice(0, layout.shown).forEach((line, index) => {
    ctx.fillText(line, layout.centerX, layout.top + offset + index * layout.lineHeight);
  });
  ctx.restore();
}

function drawFrame(ctx: CanvasRenderingContext2D, element: FrameElement) {
  const { x, y, width, height } = normalizeRect(element.x1, element.y1, element.x2, element.y2);
  ctx.save();
  ctx.fillStyle = ink(FRAME_FILL);
  ctx.fillRect(x, y, width, height);
  const own = claimsNow.get(element.id)?.mine;
  ctx.strokeStyle = own ? ink(SELECTION_COLOR) : ink(FRAME_BORDER);
  ctx.lineWidth = own ? 2.5 * labelScale : labelScale;
  ctx.strokeRect(x, y, width, height);
  ctx.restore();
}

// Names go above everything so a drawing over a frame's top edge can't hide one; zoomed out they reach well above it.
function drawFrameName(ctx: CanvasRenderingContext2D, element: FrameElement, view: Rect) {
  const label = frameLabel(element, labelScale);
  if (!rectsOverlap(frameLabelBox(label), view)) return;
  ctx.save();
  ctx.font = label.font;
  ctx.fillStyle = ink(FRAME_LABEL_COLOR);
  ctx.textBaseline = "bottom";
  ctx.fillText(label.text, label.x, label.bottom);
  const claim = claimsNow.get(element.id);
  if (claim) {
    ctx.fillStyle = ink(claim.mine ? SELECTION_COLOR : FRAME_LABEL_COLOR);
    ctx.fillText(` · ${claim.mine ? "You" : claim.name}`, label.x + ctx.measureText(label.text).width, label.bottom);
  }
  ctx.restore();
}

function plainShape(element: ShapeElement): boolean {
  if (element.sketchy === false) return false; // already drawn plainly, and cached as such
  if ((element.type === "line" || element.type === "arrow") && connectorPath(element).curved) return false;
  const { width, height } = getBounds(element);
  return Math.max(width, height) * zoomNow < PLAIN_SHAPE_MAX;
}

// A shape as plain canvas paths, in place of its Rough.js drawing. Hachure is thin lines, so a fill is drawn faint.
function drawPlain(ctx: CanvasRenderingContext2D, element: ShapeElement) {
  ctx.save();
  ctx.strokeStyle = ink(element.stroke);
  ctx.lineWidth = element.strokeWidth;
  ctx.lineJoin = "round";
  ctx.beginPath();
  if (element.type === "line" || element.type === "arrow") {
    connectorPath(element).points.forEach(({ x, y }, i) => (i ? ctx.lineTo(x, y) : ctx.moveTo(x, y)));
    for (const head of arrowHeads(element)) head.forEach(([x, y], i) => (i ? ctx.lineTo(x, y) : ctx.moveTo(x, y)));
  } else {
    const box = normalizeRect(element.x1, element.y1, element.x2, element.y2);
    const { x, y, width, height } = box;
    const corners = polygonCorners(element.type, box); // a triangle's or diamond's
    if (element.type === "ellipse")
      ctx.ellipse(x + width / 2, y + height / 2, width / 2, height / 2, 0, 0, Math.PI * 2);
    else if (corners) {
      corners.forEach(([cx, cy], i) => (i ? ctx.lineTo(cx, cy) : ctx.moveTo(cx, cy)));
      ctx.closePath();
    } else ctx.rect(x, y, width, height);
    if (element.fill) {
      ctx.globalAlpha = 0.15;
      ctx.fillStyle = ink(element.fill);
      ctx.fill();
      ctx.globalAlpha = 1;
    }
  }
  ctx.stroke();
  ctx.restore();
}

function drawUnturned(ctx: CanvasRenderingContext2D, roughCanvas: RoughCanvas, element: BoardElement) {
  if (element.type === "image") {
    drawPicture(ctx, element);
    return;
  }

  if (element.type === "sticky") {
    drawNote(ctx, element);
    return;
  }

  if (element.type === "frame") {
    drawFrame(ctx, element);
    return;
  }

  if (element.type === "pen") {
    ctx.fillStyle = ink(element.stroke);
    const path = penPath(element);
    drawMoved(path, ctx, () => ctx.fill(path.built));
    return;
  }

  if (element.type === "text") {
    const formula = formulaOf(element.text);
    if (formula) {
      // Nothing until its picture has loaded, which is a moment: canvases redraw then.
      const picture = formulaPicture(formula, ink(element.stroke));
      const { width, height } = getLocalBounds(element);
      if (picture) ctx.drawImage(picture, element.x1, element.y1, width, height);
      return;
    }
    ctx.save();
    ctx.fillStyle = ink(element.stroke);
    if (!readable(element.fontSize)) {
      const box = getLocalBounds(element);
      ctx.globalAlpha = 0.35;
      ctx.fillRect(box.x, box.y + box.height / 4, box.width, box.height / 2);
      ctx.restore();
      return;
    }
    ctx.font = fontFor(element);
    ctx.textBaseline = "top";
    const lineHeight = element.fontSize * LINE_HEIGHT;
    // Match the half-leading a <textarea> adds, so editing doesn't shift text.
    const offset = (lineHeight - element.fontSize) / 2;
    element.text.split("\n").forEach((line, index) => {
      ctx.fillText(line, element.x1, element.y1 + offset + index * lineHeight);
    });
    ctx.restore();
    return;
  }

  if (plainShape(element as ShapeElement)) {
    drawPlain(ctx, element as ShapeElement);
    return;
  }
  const drawables = (ink === sameInk ? drawableCaches.light : drawableCaches.dark).get(
    element,
    buildDrawables as (element: BoardElement) => Drawable[],
  );
  drawMoved(drawables, ctx, () => {
    for (const drawable of drawables.built) roughCanvas.draw(drawable);
  });
}

const SELECTION_COLOR = "#2d5bff";
const HANDLE_SIZE = 9; // screen pixels

function drawSelection(ctx: CanvasRenderingContext2D, element: BoardElement, zoom: number) {
  const selection = getSelectionBox(element, zoom);
  ctx.save();
  ctx.strokeStyle = ink(SELECTION_COLOR);
  ctx.lineWidth = 1.5 / zoom;
  ctx.setLineDash([5 / zoom, 4 / zoom]);

  if (selection.kind === "box") {
    const { frame, halfWidth, halfHeight } = selection;
    ctx.save();
    ctx.translate(frame.cx, frame.cy);
    ctx.rotate(frame.angle);
    ctx.strokeRect(-halfWidth, -halfHeight, halfWidth * 2, halfHeight * 2);
    ctx.restore();

    const turn = selection.handles.find((handle) => handle.id === "rotate");
    if (turn) {
      ctx.setLineDash([]);
      ctx.beginPath();
      ctx.moveTo(selection.top.x, selection.top.y);
      ctx.lineTo(turn.x, turn.y);
      ctx.stroke();
    }
  } else {
    const bounds = expandRect(getBounds(element), 6 / zoom);
    ctx.strokeRect(bounds.x, bounds.y, bounds.width, bounds.height);
  }

  ctx.setLineDash([]);
  ctx.fillStyle = ink("#ffffff");
  const size = HANDLE_SIZE / zoom;
  for (const handle of selection.handles) {
    ctx.beginPath();
    if (handle.id === "rotate") ctx.arc(handle.x, handle.y, size / 2 + 0.5 / zoom, 0, Math.PI * 2);
    else ctx.rect(handle.x - size / 2, handle.y - size / 2, size, size);
    ctx.fill();
    ctx.stroke();
  }
  ctx.restore();
}

function drawConnectTarget(ctx: CanvasRenderingContext2D, element: AnyElement, zoom: number) {
  const { cx, cy, width, height, angle } = getFrame(element);
  const pad = 4 / zoom + (element.strokeWidth ?? 0) / 2;
  ctx.save();
  ctx.translate(cx, cy);
  ctx.rotate(angle);
  ctx.strokeStyle = ink(SELECTION_COLOR);
  ctx.globalAlpha = 0.7;
  ctx.lineWidth = 2.5 / zoom;
  ctx.beginPath();
  const box = { x: -width / 2 - pad, y: -height / 2 - pad, width: width + pad * 2, height: height + pad * 2 };
  const corners = polygonCorners(element.type, box);
  if (element.type === "ellipse") ctx.ellipse(0, 0, box.width / 2, box.height / 2, 0, 0, Math.PI * 2);
  else if (corners) for (const [x, y] of corners) ctx.lineTo(x, y);
  else ctx.rect(box.x, box.y, box.width, box.height);
  ctx.closePath();
  ctx.stroke();
  ctx.restore();
}

function drawConnectionDots(ctx: CanvasRenderingContext2D, element: AnyElement, zoom: number, side: Side | null) {
  ctx.save();
  ctx.strokeStyle = ink(SELECTION_COLOR);
  ctx.lineWidth = 1.5 / zoom;
  for (const [each, dot] of Object.entries(connectionDots(element, zoom))) {
    const active = each === side;
    ctx.beginPath();
    ctx.arc(dot.x, dot.y, (active ? 6 : 4.5) / zoom, 0, Math.PI * 2);
    ctx.fillStyle = active ? ink(SELECTION_COLOR) : ink("#ffffff");
    ctx.fill();
    ctx.stroke();
  }
  ctx.restore();
}

const REMOVAL_COLOR = "#e03131";

// Suggested elements as drawn: a suggested arrow attached to shapes is drawn to where they are, which takes the
// board with the suggestions in it. Worked out again only when the board or the suggestions change.
let resolvedLayer: { elements: BoardElement[]; marks: readonly SuggestionMark[]; drawn: BoardElement[] } | null = null;

function suggestedElements(marks: readonly SuggestionMark[], elements: BoardElement[]): BoardElement[] {
  if (resolvedLayer?.elements === elements && resolvedLayer.marks === marks) return resolvedLayer.drawn;
  let drawn = marks.map((mark) => mark.element);
  if (drawn.some((element) => isConnector(element) && (element.startId || element.endId))) {
    const byId = new Map(elements.map((element) => [element.id, element]));
    for (const mark of marks) if (mark.kind !== "remove") byId.set(mark.element.id, mark.element);
    const resolved = new Map(resolveConnectors([...byId.values()]).map((element) => [element.id, element]));
    drawn = drawn.map((element, i) => (marks[i]!.kind === "remove" ? element : (resolved.get(element.id) ?? element)));
  }
  resolvedLayer = { elements, marks, drawn };
  return drawn;
}

function drawSuggestions(
  ctx: CanvasRenderingContext2D,
  roughCanvas: RoughCanvas,
  marks: readonly SuggestionMark[],
  elements: BoardElement[],
  view: Rect,
  zoom: number,
) {
  const drawn = suggestedElements(marks, elements);
  marks.forEach((mark, i) => {
    const element = drawn[i]!;
    if (!isVisible(element, view)) return;
    ctx.save();
    if (mark.ghost) {
      ctx.globalAlpha = mark.highlighted ? 0.85 : 0.55;
      drawElement(ctx, roughCanvas, element);
      ctx.globalAlpha = 1;
    }
    const box = expandRect(getBounds(element), 6 / zoom);
    ctx.strokeStyle = ink(mark.kind === "remove" ? REMOVAL_COLOR : mark.color);
    ctx.lineWidth = (mark.highlighted ? 3 : 1.75) / zoom;
    ctx.setLineDash([6 / zoom, 4 / zoom]);
    ctx.strokeRect(box.x, box.y, box.width, box.height);
    if (mark.kind === "remove") hatch(ctx, box, zoom, mark.highlighted ? 0.55 : 0.35);
    ctx.restore();
  });
}

function hatch(ctx: CanvasRenderingContext2D, box: Rect, zoom: number, opacity: number) {
  ctx.save();
  ctx.setLineDash([]);
  ctx.beginPath();
  ctx.rect(box.x, box.y, box.width, box.height);
  ctx.clip();
  ctx.globalAlpha = opacity;
  ctx.lineWidth = 1.5 / zoom;
  ctx.beginPath();
  for (let offset = -box.height; offset < box.width; offset += 10 / zoom) {
    ctx.moveTo(box.x + offset, box.y + box.height);
    ctx.lineTo(box.x + offset + box.height, box.y);
  }
  ctx.stroke();
  ctx.restore();
}

function isVisible(element: BoardElement, view: Rect): boolean {
  const b = getBounds(element);
  return (
    b.x <= view.x + view.width && b.x + b.width >= view.x && b.y <= view.y + view.height && b.y + b.height >= view.y
  );
}

export function renderScene(canvas: HTMLCanvasElement, options: RenderOptions): void {
  if (options.tiles && drawFromTiles(canvas, options)) return;
  const {
    elements,
    viewport,
    dpr = 1,
    selectedId,
    hiddenId,
    croppingId: cropping = null,
    background,
    dark = false,
    smallImages = false,
    screenLabels = false,
    connectTargetId = null,
    dots = null,
    suggestions = [],
    frameClaims = new Map(),
  } = options;
  ink = dark ? darkInk : sameInk;
  smallPictures = smallImages;
  croppingId = cropping;
  labelScale = screenLabels ? 1 / viewport.zoom : 1;
  zoomNow = viewport.zoom;
  claimsNow = frameClaims;
  picturesDrawn = new Set();
  const ctx = canvas.getContext("2d")!;
  ctx.setTransform(1, 0, 0, 1, 0, 0);
  ctx.clearRect(0, 0, canvas.width, canvas.height);
  if (background) {
    ctx.fillStyle = background;
    ctx.fillRect(0, 0, canvas.width, canvas.height);
  }

  const scale = dpr * viewport.zoom;
  ctx.setTransform(scale, 0, 0, scale, viewport.x * scale, viewport.y * scale);

  const view = {
    x: -viewport.x,
    y: -viewport.y,
    width: canvas.width / scale,
    height: canvas.height / scale,
  };

  const roughCanvas = rough.canvas(canvas);
  let selected: BoardElement | null = null;
  let target: BoardElement | null = null;
  let dotted: BoardElement | null = null;
  const frames: FrameElement[] = [];
  for (const element of inDrawOrder(resolveConnectors(elements))) {
    if (element.id === connectTargetId) target = element;
    if (element.id === dots?.id) dotted = element;
    if (element.id === selectedId) selected = element;
    const hidden = element.id === hiddenId;
    if (hidden && !isConnector(element)) continue;
    if (isFrame(element)) frames.push(element);
    if (isVisible(element, view)) drawElement(ctx, roughCanvas, element, { hideLabel: hidden });
  }
  if (suggestions.length > 0) drawSuggestions(ctx, roughCanvas, suggestions, elements, view, viewport.zoom);
  for (const cache of [drawableCaches.light, drawableCaches.dark, penPathCache]) {
    cache.trim(elements.length + suggestions.length);
  }
  showingImages(canvas, picturesDrawn, { small: smallPictures });
  for (const frame of frames) drawFrameName(ctx, frame, view);
  drawMarks(ctx, { target, dotted, selected }, options);
}

function drawMarks(
  ctx: CanvasRenderingContext2D,
  { target, dotted, selected }: Record<"target" | "dotted" | "selected", BoardElement | null>,
  { viewport, dots = null, hiddenId }: RenderOptions,
) {
  if (target) drawConnectTarget(ctx, target, viewport.zoom);
  if (dotted) drawConnectionDots(ctx, dotted, viewport.zoom, dots!.side);
  if (selected && selected.id !== hiddenId) drawSelection(ctx, selected, viewport.zoom);
}

// Bumped when text measures differently (see forgetMeasurements), which changes what the tiles drew.
let measurementsEpoch = 0;
let tileSheet: OffscreenCanvas | undefined; // what each tile is drawn on, and then taken from, in turn

// Tiles hold only the board as stored, so a text being edited, a cropped picture, suggestions, a background and screens
// too big for the kept tiles are drawn outright (returns false, drawing nothing).
function drawFromTiles(canvas: HTMLCanvasElement, options: RenderOptions): boolean {
  const { tiles, elements, viewport, dpr = 1, dark = false, screenLabels = false, frameClaims = new Map() } = options;
  const { hiddenId, croppingId: cropping, background, smallImages, suggestions = [] } = options;
  if (!tiles || typeof OffscreenCanvas === "undefined") return false;
  if (!drawsFromTiles(viewport.zoom)) {
    tiles.clear(); // zoomed in, they are of no use and hold memory
    return false;
  }
  if (hiddenId || cropping || background || smallImages || suggestions.length > 0) return false;
  // Tiles are in device pixels so a board point always lands on the same one and they join up; the board sits a whole number of pixels along.
  const scale = dpr * viewport.zoom;
  const left = Math.round(viewport.x * scale);
  const top = Math.round(viewport.y * scale);
  const range = {
    i0: Math.floor(-left / TILE),
    i1: Math.floor((canvas.width - 1 - left) / TILE),
    j0: Math.floor(-top / TILE),
    j1: Math.floor((canvas.height - 1 - top) / TILE),
  };
  if (tileCount(range) > MAX_TILES) return false;

  const drawn = resolveConnectors(elements);
  const claims = [...frameClaims].map(([id, { name, mine }]) => `${id}:${mine}:${name}`).join(";");
  const labels = screenLabels ? 1 / viewport.zoom : 1;
  const look = [dark, dpr, viewport.zoom, screenLabels, measurementsEpoch, imagesVersion(), claims].join("|");
  const steady = tiles.sync(look, drawn, scale, (element) => {
    let box = getBounds(element);
    if (isFrame(element)) box = unionRects([box, frameLabelBox(frameLabel(element, labels))])!;
    return expandRect(box, GUTTER / scale);
  });
  if (!steady) return false; // the first time at this zoom, which a zoom gesture only passes through, is drawn outright

  const visible = [];
  for (let j = range.j0; j <= range.j1; j += 1) {
    for (let i = range.i0; i <= range.i1; i += 1) visible.push({ i, j, entry: tiles.get(i, j) });
  }
  const pictures = new Set<string>();
  const ready = visible.map(({ i, j, entry }) => {
    let tile = entry?.tile;
    if (!tile || entry!.stale) {
      const at = { x: (GUTTER - i * TILE) / scale, y: (GUTTER - j * TILE) / scale, zoom: viewport.zoom };
      if (!tileSheet) {
        tileSheet = new OffscreenCanvas(TILE + GUTTER * 2, TILE + GUTTER * 2);
        tileSheet.getContext("2d", { willReadFrequently: true });
      }
      const sheet = tileSheet as unknown as HTMLCanvasElement;
      renderScene(sheet, { elements, viewport: at, dpr, dark, screenLabels, frameClaims });
      releaseImages(sheet);
      tile = { bitmap: tileSheet.transferToImageBitmap(), pictures: picturesDrawn };
      tiles.put(i, j, tile);
    }
    for (const id of tile.pictures) pictures.add(id);
    return { i, j, bitmap: tile.bitmap };
  });

  // Each tile was drawn with the look this scene has, which is left set for what goes over them.
  picturesDrawn = pictures;
  const ctx = canvas.getContext("2d")!;
  ctx.setTransform(1, 0, 0, 1, 0, 0);
  ctx.clearRect(0, 0, canvas.width, canvas.height);
  for (const { i, j, bitmap } of ready) {
    ctx.drawImage(bitmap, GUTTER, GUTTER, TILE, TILE, left + i * TILE, top + j * TILE, TILE, TILE);
  }
  showingImages(canvas, pictures);
  ctx.setTransform(scale, 0, 0, scale, left, top);
  const find = (id: string | null | undefined) => (id ? (drawn.find((element) => element.id === id) ?? null) : null);
  drawMarks(
    ctx,
    { target: find(options.connectTargetId), dotted: find(options.dots?.id), selected: find(options.selectedId) },
    options,
  );
  return true;
}

let fontsPromise: Promise<void> | undefined;

// Canvas text only uses a web font once it has loaded, so wait before drawing.
export function loadCanvasFonts(): Promise<void> {
  fontsPromise ??= Promise.all(
    ['32px "Caveat Variable"', '32px "Archivo Variable"', '32px "JetBrains Mono Variable"'].map((font) =>
      document.fonts.load(font),
    ),
  )
    .catch(() => {})
    .then(forgetMeasurements);
  return fontsPromise;
}

// Text measures differently once web fonts have loaded, and an equation once it is typeset.
function forgetMeasurements() {
  measurementsEpoch += 1;
  forgetNoteMeasurements();
  forgetFrameLabels();
  forgetConnectorLabels();
  forgetBounds();
  forgetResolvedConnectors();
}
onFormulasChanged(() => {
  forgetMeasurements();
  picturesChanged();
});
