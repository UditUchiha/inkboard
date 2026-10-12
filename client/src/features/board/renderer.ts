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
import { connectionDots, forgetResolvedConnectors, isConnector, resolveConnectors } from "./connectors";
import { FRAME_BORDER, FRAME_FILL, FRAME_LABEL_COLOR, LINE_HEIGHT, NOTE_TEXT_COLOR } from "./constants";
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
} from "./elements";
import type { AnyElement, Connector } from "./elements";
import { expandRect, normalizeRect, rectCenter, rectsOverlap } from "./geometry";
import type { Rect, Viewport } from "./geometry";
import { getImage, showingImages } from "./images";
import { darkInk } from "./ink";
import { forgetNoteMeasurements, noteLayout } from "./notes";
import { connectorPath, pathData } from "./routes";
import type { SuggestionMark } from "./suggestions";
import { getSelectionBox } from "./transform";

/** Turns a stored colour into the one to draw. */
type Ink = (color: string) => string;

/** What renderScene takes besides the canvas: what to draw, where it is looked at and how it is shown (see there). */
export type RenderOptions = {
  elements: BoardElement[];
  viewport: Viewport;
  dpr?: number;
  selectedId?: string | null;
  hiddenId?: string | null;
  // A picture being cropped, which also shows the rest of the picture, faded.
  croppingId?: string | null;
  background?: string | null;
  dark?: boolean;
  smallImages?: boolean;
  screenLabels?: boolean;
  connectTargetId?: string | null;
  dots?: { id: string; side: Side | null } | null;
  suggestions?: readonly SuggestionMark[];
};

const generator = rough.generator();

// How the scene being rendered is drawn: its colors (as stored, or as dark mode
// shows them, see ink.ts), whether pictures come from their small copies (for
// thumbnails), and how many board units a pixel of frame name or border takes
// (see frameLabel). Set by renderScene.
const sameInk: Ink = (color) => color;
let ink: Ink = sameInk;
let smallPictures = false;
let labelScale = 1;
let picturesDrawn = new Set<string>(); // the image ids drawn in the scene being rendered
let croppingId: string | null = null;

// Elements are immutable, so generated shapes can be cached per object (and
// reused for copies that are only moved, as while dragging: see drawCache.ts).
// Shapes carry their colors, so light and dark mode each have their own.
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

// `paint` turns each stored color into the one to draw (see `ink`).
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
    default:
      return [];
  }
}

const average = (a: number, b: number): number => (a + b) / 2;

// Turns perfect-freehand's outline polygon into a smooth closed SVG path.
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

/** A pen stroke's outline as SVG path data, filled with the stroke color to draw it. */
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

// A pen stroke's outline and how far along it is drawn.
// (The cast: the cache is only asked about pen strokes.)
const penPath = (element: PenElement) =>
  penPathCache.get(element, (stroke) => new Path2D(penOutline(stroke as PenElement)));

// Draws what a cache gave for an element (see createDrawingCache) where the element is.
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

/**
 * A line, arrow, rectangle or ellipse as the SVG paths the canvas draws, in its
 * stored colors: `[{ d, stroke, strokeWidth, fill }]`.
 */
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
  // Turned elements are drawn upright, in a space turned about their centre.
  const center = rectCenter(getLocalBounds(element));
  ctx.save();
  ctx.translate(center.x, center.y);
  ctx.rotate(element.angle);
  ctx.translate(-center.x, -center.y);
  drawUnturned(ctx, roughCanvas, element);
  ctx.restore();
}

// A line or arrow, broken around its label, and the label.
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
  // Everything but the label's box: the bounds around it, with the box cut out.
  const around = expandRect(getBounds(element), 8);
  ctx.beginPath();
  ctx.rect(around.x, around.y, around.width, around.height);
  ctx.rect(label.x, label.y, label.width, label.height);
  ctx.clip("evenodd");
  drawUnturned(ctx, roughCanvas, element);
  ctx.restore();
  if (hideLabel) return;
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

// A picture, or a plain box in its place while it downloads (or if it can't).
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
        // The whole picture, where it would be at this scale, so the person cropping sees what they can bring back.
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
  ctx.shadowColor = "rgba(22, 33, 58, 0.18)";
  ctx.shadowBlur = Math.min(width, height) * 0.05 * pixels;
  ctx.shadowOffsetY = Math.min(width, height) * 0.015 * pixels;
  ctx.fillStyle = ink(element.fill);
  ctx.fillRect(x, y, width, height);
  ctx.restore();

  const layout = noteLayout(element);
  ctx.save();
  // Only the lines that fit are drawn (see layoutNote); on a note too small for
  // even one, it's cut off at the note's edge.
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
  ctx.strokeStyle = ink(FRAME_BORDER);
  ctx.lineWidth = labelScale;
  ctx.strokeRect(x, y, width, height);
  ctx.restore();
}

// Names go above everything, so a drawing reaching over a frame's top edge can't hide one.
// A name is seen on its own: zoomed out, it reaches well above the frame.
function drawFrameName(ctx: CanvasRenderingContext2D, element: FrameElement, view: Rect) {
  const label = frameLabel(element, labelScale);
  if (!rectsOverlap(frameLabelBox(label), view)) return;
  ctx.save();
  ctx.font = label.font;
  ctx.fillStyle = ink(FRAME_LABEL_COLOR);
  ctx.textBaseline = "bottom";
  ctx.fillText(label.text, label.x, label.bottom);
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
    ctx.save();
    ctx.font = fontFor(element);
    ctx.fillStyle = ink(element.stroke);
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

  // The cast: buildDrawables takes shapes, and only shapes are left here.
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

// A dashed box around the selected element, with a handle to drag on each side and
// corner and one above to turn it. Lines and arrows get a handle on each end instead.
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

// The shape a connector end will attach to, while one is being drawn or dragged.
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
  if (element.type === "ellipse") ctx.ellipse(0, 0, width / 2 + pad, height / 2 + pad, 0, 0, Math.PI * 2);
  else ctx.rect(-width / 2 - pad, -height / 2 - pad, width + pad * 2, height + pad * 2);
  ctx.stroke();
  ctx.restore();
}

// The dots around a shape that connectors start from or are pinned to, `side`'s highlighted.
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

// A suggested removal is outlined and hatched in this red; other suggestions in their author's color.
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

// Suggestions over the board (see suggestions.ts): what they'd add or change, faded, in a dashed outline of their
// author's color; what they'd remove, outlined and hatched in red. The ones `highlighted` stand out.
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

// Diagonal lines across `box`, in the stroke color as set, at `opacity`.
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

/**
 * Draws `elements` onto `canvas`. Pass `dark` to draw them as dark mode shows
 * them (pictures keep their own colors), `smallImages` for thumbnails,
 * `screenLabels` to keep frame names the same size on screen at any zoom,
 * `connectTargetId` to outline the shape a connector end is about to attach
 * to, `dots` ({ id, side }) to show a shape's connection dots, `side`'s
 * highlighted, and `suggestions` to draw those over the board. The element
 * `hiddenId` is left out while it's edited; for a connector, only its label is.
 */
export function renderScene(
  canvas: HTMLCanvasElement,
  {
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
  }: RenderOptions,
): void {
  ink = dark ? darkInk : sameInk;
  smallPictures = smallImages;
  croppingId = cropping;
  labelScale = screenLabels ? 1 / viewport.zoom : 1;
  picturesDrawn = new Set();
  // The assertion: a canvas that has no other kind of context gives a 2d one.
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
  // The pictures on show here are kept while they are (see showingImages).
  showingImages(canvas, picturesDrawn, { small: smallPictures });
  for (const frame of frames) drawFrameName(ctx, frame, view);
  if (target) drawConnectTarget(ctx, target, viewport.zoom);
  // The assertion: `dotted` is only found when there is a `dots` to name it.
  if (dotted) drawConnectionDots(ctx, dotted, viewport.zoom, dots!.side);
  if (selected && selected.id !== hiddenId) drawSelection(ctx, selected, viewport.zoom);
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
    .then(() => {
      forgetNoteMeasurements();
      forgetFrameLabels();
      forgetConnectorLabels();
      forgetBounds();
      forgetResolvedConnectors();
    });
  return fontsPromise;
}
