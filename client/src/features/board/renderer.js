import getStroke from "perfect-freehand";
import rough from "roughjs";
import { createDrawingCache } from "./drawCache";
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
import { expandRect, normalizeRect, rectCenter, rectsOverlap } from "./geometry";
import { getImage, showingImages } from "./images";
import { darkInk } from "./ink";
import { forgetNoteMeasurements, noteLayout } from "./notes";
import { connectorPath, pathData } from "./routes";
import { getSelectionBox } from "./transform";

const generator = rough.generator();

// How the scene being rendered is drawn: its colors (as stored, or as dark mode
// shows them, see ink.js), whether pictures come from their small copies (for
// thumbnails), and how many board units a pixel of frame name or border takes
// (see frameLabel). Set by renderScene.
const sameInk = (color) => color;
let ink = sameInk;
let smallPictures = false;
let labelScale = 1;
let picturesDrawn = new Set(); // the image ids drawn in the scene being rendered

// Elements are immutable, so generated shapes can be cached per object (and
// reused for copies that are only moved, as while dragging: see drawCache.js).
// Shapes carry their colors, so light and dark mode each have their own.
const drawableCaches = { light: createDrawingCache(), dark: createDrawingCache() };
const penPathCache = createDrawingCache();

function roughOptions(element, paint) {
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
function buildDrawables(element, paint = ink) {
  const options = roughOptions(element, paint);
  const { x1, y1, x2, y2 } = element;
  switch (element.type) {
    case "line":
    case "arrow": {
      const path = connectorPath(element);
      let body;
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

const average = (a, b) => (a + b) / 2;

// Turns perfect-freehand's outline polygon into a smooth closed SVG path.
function svgPathFromOutline(points) {
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
export function penOutline(element) {
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
const penPath = (element) => penPathCache.get(element, (stroke) => new Path2D(penOutline(stroke)));

// Draws what a cache gave for an element (see createDrawingCache) where the element is.
function drawMoved({ dx, dy }, ctx, draw) {
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
export function shapePaths(element) {
  return buildDrawables(element, sameInk).flatMap((drawable) => generator.toPaths(drawable));
}

// `hideLabel` leaves out a connector's label (while it's being edited).
function drawElement(ctx, roughCanvas, element, { hideLabel = false } = {}) {
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
function drawConnector(ctx, roughCanvas, element, hideLabel) {
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
function drawPicture(ctx, element) {
  const { image, state } = getImage(element.imageId, { small: smallPictures });
  picturesDrawn.add(element.imageId);
  const { x, y, width, height } = normalizeRect(element.x1, element.y1, element.x2, element.y2);
  ctx.save();
  if (state === "ready") {
    ctx.imageSmoothingQuality = "high";
    ctx.drawImage(image, x, y, width, height);
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
function drawNote(ctx, element) {
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

function drawFrame(ctx, element) {
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
function drawFrameName(ctx, element, view) {
  const label = frameLabel(element, labelScale);
  if (!rectsOverlap(frameLabelBox(label), view)) return;
  ctx.save();
  ctx.font = label.font;
  ctx.fillStyle = ink(FRAME_LABEL_COLOR);
  ctx.textBaseline = "bottom";
  ctx.fillText(label.text, label.x, label.bottom);
  ctx.restore();
}

function drawUnturned(ctx, roughCanvas, element) {
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

  const drawables = (ink === sameInk ? drawableCaches.light : drawableCaches.dark).get(element, buildDrawables);
  drawMoved(drawables, ctx, () => {
    for (const drawable of drawables.built) roughCanvas.draw(drawable);
  });
}

const SELECTION_COLOR = "#2d5bff";
const HANDLE_SIZE = 9; // screen pixels

// A dashed box around the selected element, with a handle to drag on each side and
// corner and one above to turn it. Lines and arrows get a handle on each end instead.
function drawSelection(ctx, element, zoom) {
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
function drawConnectTarget(ctx, element, zoom) {
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
function drawConnectionDots(ctx, element, zoom, side) {
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

function isVisible(element, view) {
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
 * to, and `dots` ({ id, side }) to show a shape's connection dots, `side`'s
 * highlighted. The element `hiddenId` is left out while it's edited; for a
 * connector, only its label is.
 */
export function renderScene(
  canvas,
  {
    elements,
    viewport,
    dpr = 1,
    selectedId,
    hiddenId,
    background,
    dark = false,
    smallImages = false,
    screenLabels = false,
    connectTargetId = null,
    dots = null,
  },
) {
  ink = dark ? darkInk : sameInk;
  smallPictures = smallImages;
  labelScale = screenLabels ? 1 / viewport.zoom : 1;
  picturesDrawn = new Set();
  const ctx = canvas.getContext("2d");
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
  let selected = null;
  let target = null;
  let dotted = null;
  const frames = [];
  for (const element of inDrawOrder(resolveConnectors(elements))) {
    if (element.id === connectTargetId) target = element;
    if (element.id === dots?.id) dotted = element;
    if (element.id === selectedId) selected = element;
    const hidden = element.id === hiddenId;
    if (hidden && !isConnector(element)) continue;
    if (isFrame(element)) frames.push(element);
    if (isVisible(element, view)) drawElement(ctx, roughCanvas, element, { hideLabel: hidden });
  }
  for (const cache of [drawableCaches.light, drawableCaches.dark, penPathCache]) cache.trim(elements.length);
  // The pictures on show here are kept while they are (see showingImages).
  showingImages(canvas, picturesDrawn, { small: smallPictures });
  for (const frame of frames) drawFrameName(ctx, frame, view);
  if (target) drawConnectTarget(ctx, target, viewport.zoom);
  if (dotted) drawConnectionDots(ctx, dotted, viewport.zoom, dots.side);
  if (selected && selected.id !== hiddenId) drawSelection(ctx, selected, viewport.zoom);
}

let fontsPromise;

// Canvas text only uses a web font once it has loaded, so wait before drawing.
export function loadCanvasFonts() {
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
