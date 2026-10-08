import { FONTS, LINE_HEIGHT } from "./constants";
import { normalizeRect } from "./geometry";

// How a sticky note lays out its text: wrapped to the note's width, centered,
// and as large as the note allows. Text starts at a size that suits the note and
// shrinks until every line fits, the way paper notes get smaller writing when
// there's more to say. Everything that draws a note (the canvas, SVG export,
// the editor) uses this, so a note looks the same everywhere.

export const NOTE_PADDING = 0.09; // of the note's shorter side, on every edge
export const MIN_NOTE_FONT_SIZE = 6;
const SHRINK = 0.9;

/**
 * `text` broken into lines no wider than `maxWidth`, measured by `measure(line)`.
 * Lines break between words; a word too long for a line of its own is broken
 * between letters. Line breaks in the text are kept.
 */
export function wrapLines(text, maxWidth, measure) {
  const lines = [];
  for (const paragraph of text.split("\n")) {
    let line = "";
    for (const word of paragraph.split(" ")) {
      const candidate = line ? `${line} ${word}` : word;
      if (measure(candidate) <= maxWidth) {
        line = candidate;
        continue;
      }
      if (line) lines.push(line);
      line = word;
      while (line.length > 1 && measure(line) > maxWidth) {
        let fits = 1;
        while (fits < line.length - 1 && measure(line.slice(0, fits + 1)) <= maxWidth) fits += 1;
        lines.push(line.slice(0, fits));
        line = line.slice(fits);
      }
    }
    lines.push(line);
  }
  return lines;
}

/**
 * Where a note's text goes: `{ fontSize, lines, lineHeight, centerX, top, width, height }`,
 * with `top` the top of the first line. `measure(text, fontSize, font)` gives
 * the width of `text` at that size.
 */
export function layoutNote(element, measure) {
  const box = normalizeRect(element.x1, element.y1, element.x2, element.y2);
  const pad = Math.min(box.width, box.height) * NOTE_PADDING;
  const width = Math.max(1, box.width - pad * 2);
  const height = Math.max(1, box.height - pad * 2);

  let fontSize = Math.max(MIN_NOTE_FONT_SIZE, Math.round(Math.min(box.width, box.height) / 7));
  let lines;
  for (;;) {
    const size = fontSize;
    lines = wrapLines(element.text, width, (line) => measure(line, size, element.font));
    const fits = lines.length * fontSize * LINE_HEIGHT <= height;
    if (fits || fontSize <= MIN_NOTE_FONT_SIZE) break;
    fontSize = Math.max(MIN_NOTE_FONT_SIZE, Math.floor(fontSize * SHRINK));
  }
  const lineHeight = fontSize * LINE_HEIGHT;
  return {
    fontSize,
    lines,
    lineHeight,
    centerX: box.x + box.width / 2,
    top: box.y + box.height / 2 - (lines.length * lineHeight) / 2,
    width,
    height,
  };
}

// Text width scales with font size, so each piece of text is measured once, at
// a reference size, and scaled.
const REFERENCE_SIZE = 100;
const widths = new Map(); // font -> Map(text -> width at REFERENCE_SIZE)
let context;

function measureInCanvas(text, fontSize, font) {
  const key = FONTS[font] ? font : "hand";
  let known = widths.get(key);
  if (!known) {
    known = new Map();
    widths.set(key, known);
  }
  let width = known.get(text);
  if (width === undefined) {
    context ??= document.createElement("canvas").getContext("2d");
    context.font = `${REFERENCE_SIZE}px ${FONTS[key].family}`;
    width = context.measureText(text).width;
    if (known.size > 20_000) known.clear();
    known.set(text, width);
  }
  return (width * fontSize) / REFERENCE_SIZE;
}

let layouts = new WeakMap();

/** A note's layout in the browser, measured with the canvas and cached per element. */
export function noteLayout(element) {
  let layout = layouts.get(element);
  if (!layout) {
    layout = layoutNote(element, measureInCanvas);
    layouts.set(element, layout);
  }
  return layout;
}

/** Forget measured widths and layouts, once web fonts have loaded and text measures differently. */
export function forgetNoteMeasurements() {
  widths.clear();
  layouts = new WeakMap();
}
