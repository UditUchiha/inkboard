import getStroke from "perfect-freehand";
import rough from "roughjs";
import { LINE_HEIGHT } from "./constants";
import { arrowHeadLength, fontFor, getBounds } from "./elements";
import { arrowHeadPoints, expandRect, normalizeRect } from "./geometry";

const generator = rough.generator();

// Elements are immutable, so generated shapes can be cached per object.
const drawableCache = new WeakMap();
const penPathCache = new WeakMap();

function roughOptions(element) {
  const sketchy = element.sketchy !== false;
  return {
    seed: element.seed,
    stroke: element.stroke,
    strokeWidth: element.strokeWidth,
    roughness: sketchy ? 1.1 : 0,
    bowing: sketchy ? 1 : 0,
    disableMultiStroke: !sketchy,
    preserveVertices: !sketchy,
    fill: element.fill || undefined,
    fillStyle: sketchy ? "hachure" : "solid",
    fillWeight: Math.max(element.strokeWidth / 2, 0.75),
    hachureGap: 4 + element.strokeWidth * 2,
  };
}

function buildDrawables(element) {
  const options = roughOptions(element);
  const { x1, y1, x2, y2 } = element;
  switch (element.type) {
    case "line":
      return [generator.line(x1, y1, x2, y2, options)];
    case "arrow": {
      const [a, b] = arrowHeadPoints(x1, y1, x2, y2, arrowHeadLength(element));
      return [generator.line(x1, y1, x2, y2, options), generator.linearPath([a, [x2, y2], b], options)];
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

function penPath(element) {
  let path = penPathCache.get(element);
  if (!path) {
    const outline = getStroke(element.points, {
      size: element.penSize,
      thinning: 0.55,
      smoothing: 0.5,
      streamline: 0.45,
      simulatePressure: !element.pressure,
    });
    path = new Path2D(svgPathFromOutline(outline));
    penPathCache.set(element, path);
  }
  return path;
}

function drawElement(ctx, roughCanvas, element) {
  if (element.type === "pen") {
    ctx.fillStyle = element.stroke;
    ctx.fill(penPath(element));
    return;
  }

  if (element.type === "text") {
    ctx.save();
    ctx.font = fontFor(element);
    ctx.fillStyle = element.stroke;
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

  let drawables = drawableCache.get(element);
  if (!drawables) {
    drawables = buildDrawables(element);
    drawableCache.set(element, drawables);
  }
  for (const drawable of drawables) roughCanvas.draw(drawable);
}

function drawSelection(ctx, element, zoom) {
  const bounds = expandRect(getBounds(element), 6 / zoom);
  ctx.save();
  ctx.strokeStyle = "#2d5bff";
  ctx.lineWidth = 1.5 / zoom;
  ctx.setLineDash([5 / zoom, 4 / zoom]);
  ctx.strokeRect(bounds.x, bounds.y, bounds.width, bounds.height);
  ctx.restore();
}

function isVisible(element, view) {
  const b = getBounds(element);
  return b.x <= view.x + view.width && b.x + b.width >= view.x && b.y <= view.y + view.height && b.y + b.height >= view.y;
}

export function renderScene(canvas, { elements, viewport, dpr = 1, selectedId, hiddenId, background }) {
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
  for (const element of elements) {
    if (element.id === selectedId) selected = element;
    if (element.id === hiddenId || !isVisible(element, view)) continue;
    drawElement(ctx, roughCanvas, element);
  }
  if (selected && selected.id !== hiddenId) drawSelection(ctx, selected, viewport.zoom);
}

let fontsPromise;

// Canvas text only uses a web font once it has loaded, so wait before drawing.
export function loadCanvasFonts() {
  fontsPromise ??= Promise.all(
    ['32px "Caveat Variable"', '32px "Archivo Variable"', '32px "JetBrains Mono Variable"'].map((font) =>
      document.fonts.load(font),
    ),
  ).catch(() => {});
  return fontsPromise;
}
