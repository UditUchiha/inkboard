import { FONTS, LINE_HEIGHT } from "./constants";
import { canRotate, getLocalBounds, getSceneBounds } from "./elements";
import { normalizeRect, rectCenter } from "./geometry";
import { penOutline, shapePaths } from "./renderer";

// A board as an SVG file: the same shapes, strokes and text the canvas draws,
// as vectors, in the colors they're stored in (light mode). Pictures and the
// fonts the text uses are embedded, so the file looks the same anywhere.

export const SVG_PADDING = 32;

const XML_ESCAPES = { "&": "&amp;", "<": "&lt;", ">": "&gt;", '"': "&quot;", "'": "&apos;" };
const xml = (value) => String(value).replace(/[&<>"']/g, (char) => XML_ESCAPES[char]);
const num = (value) => String(Math.round(value * 100) / 100);

// Where a line's alphabetic baseline sits below the top of its text, as a share
// of the font size. The canvas draws text from the top of the em box; SVG
// places it by its baseline. Measured in the browser by `measureBaselines`.
const FALLBACK_BASELINE = 0.8;

function turned(element, inner) {
  if (!canRotate(element) || !element.angle) return inner;
  const { x, y } = rectCenter(getLocalBounds(element));
  return `<g transform="rotate(${num((element.angle * 180) / Math.PI)} ${num(x)} ${num(y)})">${inner}</g>`;
}

function textSvg(element, baselines) {
  const font = FONTS[element.font] ? element.font : "hand";
  const family = FONTS[font].family;
  const lineHeight = element.fontSize * LINE_HEIGHT;
  // The same half-leading the canvas (and the text editor) adds above each line.
  const top = element.y1 + (lineHeight - element.fontSize) / 2;
  const baseline = (baselines[font] ?? FALLBACK_BASELINE) * element.fontSize;
  const lines = element.text
    .split("\n")
    .map((line, index) => `<tspan x="${num(element.x1)}" y="${num(top + baseline + index * lineHeight)}">${xml(line)}</tspan>`)
    .join("");
  return `<text font-family="${xml(family)}" font-size="${num(element.fontSize)}" fill="${xml(element.stroke)}" xml:space="preserve">${lines}</text>`;
}

function pictureSvg(element, images) {
  const { x, y, width, height } = normalizeRect(element.x1, element.y1, element.x2, element.y2);
  const box = `x="${num(x)}" y="${num(y)}" width="${num(width)}" height="${num(height)}"`;
  const href = images.get(element.imageId);
  if (!href) return `<rect ${box} fill="#80808020" stroke="#80808099" stroke-dasharray="6 5"/>`;
  return `<image ${box} preserveAspectRatio="none" href="${xml(href)}"/>`;
}

function elementSvg(element, { images, baselines }) {
  switch (element.type) {
    case "pen":
      return `<path d="${penOutline(element)}" fill="${xml(element.stroke)}"/>`;
    case "text":
      return textSvg(element, baselines);
    case "image":
      return pictureSvg(element, images);
    default:
      return shapePaths(element)
        .map(
          (path) =>
            `<path d="${path.d}" stroke="${xml(path.stroke)}" stroke-width="${num(path.strokeWidth)}" fill="${xml(path.fill ?? "none")}"/>`,
        )
        .join("");
  }
}

/**
 * The SVG document for `elements`, or null if there's nothing to draw.
 * `images` maps image ids to data URLs, `fontFaces` is CSS (@font-face rules)
 * to embed, and `baselines` gives each font's baseline as a share of its size.
 */
export function buildSvg(elements, { images = new Map(), fontFaces = "", baselines = {}, background = "#ffffff" } = {}) {
  const bounds = getSceneBounds(elements);
  if (!bounds) return null;
  const x = bounds.x - SVG_PADDING;
  const y = bounds.y - SVG_PADDING;
  const width = bounds.width + SVG_PADDING * 2;
  const height = bounds.height + SVG_PADDING * 2;

  const body = elements.map((element) => turned(element, elementSvg(element, { images, baselines }))).join("\n");
  return [
    `<svg xmlns="http://www.w3.org/2000/svg" width="${num(width)}" height="${num(height)}" viewBox="${num(x)} ${num(y)} ${num(width)} ${num(height)}">`,
    fontFaces && `<defs><style>${fontFaces}</style></defs>`,
    background && `<rect x="${num(x)}" y="${num(y)}" width="${num(width)}" height="${num(height)}" fill="${xml(background)}"/>`,
    body,
    "</svg>",
  ]
    .filter(Boolean)
    .join("\n");
}

/** Text fonts used by `elements`, by key (see FONTS). */
export const fontsUsed = (elements) =>
  new Set(elements.filter((element) => element.type === "text" && element.text).map((element) => (FONTS[element.font] ? element.font : "hand")));
