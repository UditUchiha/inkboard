import {
  FONTS,
  FRAME_BORDER,
  FRAME_FILL,
  FRAME_LABEL_COLOR,
  FRAME_LABEL_SIZE,
  LINE_HEIGHT,
  NOTE_TEXT_COLOR,
} from "./constants";
import { canRotate, frameLabel, getLocalBounds, getSceneBounds, inDrawOrder, isFrame } from "./elements";
import { normalizeRect, rectCenter } from "./geometry";
import { noteLayout } from "./notes";
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
    .map(
      (line, index) =>
        `<tspan x="${num(element.x1)}" y="${num(top + baseline + index * lineHeight)}">${xml(line)}</tspan>`,
    )
    .join("");
  return `<text font-family="${xml(family)}" font-size="${num(element.fontSize)}" fill="${xml(element.stroke)}" xml:space="preserve">${lines}</text>`;
}

const fontKey = (font) => (FONTS[font] ? font : "hand");

function noteSvg(element, baselines) {
  const { x, y, width, height } = normalizeRect(element.x1, element.y1, element.x2, element.y2);
  const layout = noteLayout(element);
  const font = fontKey(element.font);
  const top = layout.top + (layout.lineHeight - layout.fontSize) / 2;
  const baseline = (baselines[font] ?? FALLBACK_BASELINE) * layout.fontSize;
  const lines = layout.lines
    .map(
      (line, index) =>
        `<tspan x="${num(layout.centerX)}" y="${num(top + baseline + index * layout.lineHeight)}">${xml(line)}</tspan>`,
    )
    .join("");
  return [
    `<rect x="${num(x)}" y="${num(y)}" width="${num(width)}" height="${num(height)}" fill="${xml(element.fill)}"/>`,
    `<text font-family="${xml(FONTS[font].family)}" font-size="${num(layout.fontSize)}" fill="${NOTE_TEXT_COLOR}" text-anchor="middle" xml:space="preserve">${lines}</text>`,
  ].join("");
}

const frameSvg = (element) => {
  const { x, y, width, height } = normalizeRect(element.x1, element.y1, element.x2, element.y2);
  return `<rect x="${num(x)}" y="${num(y)}" width="${num(width)}" height="${num(height)}" fill="${FRAME_FILL}" stroke="${FRAME_BORDER}" stroke-width="1"/>`;
};

function frameNameSvg(element, baselines) {
  const label = frameLabel(element);
  const baseline = label.bottom - FRAME_LABEL_SIZE + (baselines.sans ?? FALLBACK_BASELINE) * FRAME_LABEL_SIZE;
  return `<text x="${num(label.x)}" y="${num(baseline)}" font-family="${xml(FONTS.sans.family)}" font-size="${FRAME_LABEL_SIZE}" font-weight="500" fill="${FRAME_LABEL_COLOR}" xml:space="preserve">${xml(label.text)}</text>`;
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
    case "sticky":
      return noteSvg(element, baselines);
    case "frame":
      return frameSvg(element);
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
export function buildSvg(
  elements,
  { images = new Map(), fontFaces = "", baselines = {}, background = "#ffffff" } = {},
) {
  const bounds = getSceneBounds(elements);
  if (!bounds) return null;
  const x = bounds.x - SVG_PADDING;
  const y = bounds.y - SVG_PADDING;
  const width = bounds.width + SVG_PADDING * 2;
  const height = bounds.height + SVG_PADDING * 2;

  const body = [
    ...inDrawOrder(elements).map((element) => turned(element, elementSvg(element, { images, baselines }))),
    // Frame names go on top, as on the canvas.
    ...elements.filter(isFrame).map((frame) => frameNameSvg(frame, baselines)),
  ].join("\n");
  return [
    `<svg xmlns="http://www.w3.org/2000/svg" width="${num(width)}" height="${num(height)}" viewBox="${num(x)} ${num(y)} ${num(width)} ${num(height)}">`,
    fontFaces && `<defs><style>${fontFaces}</style></defs>`,
    background &&
      `<rect x="${num(x)}" y="${num(y)}" width="${num(width)}" height="${num(height)}" fill="${xml(background)}"/>`,
    body,
    "</svg>",
  ]
    .filter(Boolean)
    .join("\n");
}

/** Text fonts used by `elements`, by key (see FONTS). Frame names are in the sans font. */
export function fontsUsed(elements) {
  const fonts = new Set();
  for (const element of elements) {
    if ((element.type === "text" || element.type === "sticky") && element.text) fonts.add(fontKey(element.font));
    if (isFrame(element)) fonts.add("sans");
  }
  return fonts;
}
