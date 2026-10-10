import { FONTS, LINE_HEIGHT, fontKey } from "./constants";
import { normalizeRect } from "./geometry";

// How a sticky note lays out its text: wrapped to the note's width, centered,
// and as large as the note allows. Text starts at a size that suits the note and
// shrinks until every line fits, the way paper notes get smaller writing when
// there's more to say. Everything that draws a note (the canvas, SVG export,
// the editor) uses this, so a note looks the same everywhere.

export const NOTE_PADDING = 0.09; // of the note's shorter side, on every edge
export const MIN_NOTE_FONT_SIZE = 6;
const SHRINK = 0.9;

// Whole characters as people see them, so a break never splits an emoji, a
// flag, or a letter with its accents.
const segmenter =
  typeof Intl !== "undefined" && Intl.Segmenter ? new Intl.Segmenter(undefined, { granularity: "grapheme" }) : null;
export const charactersOf = (word) =>
  segmenter ? Array.from(segmenter.segment(word), (part) => part.segment) : Array.from(word);

// How many characters from `start` fit in `maxWidth`, at least one: doubling
// until one doesn't, then halving back, so it measures the length of a line a
// few times over, never the word that's left.
function charactersThatFit(characters, start, maxWidth, measure) {
  const remaining = characters.length - start;
  const fits = (count) => measure(characters.slice(start, start + count).join("")) <= maxWidth;
  let low = 1; // a line takes at least one character, fitting or not
  let high = 2; // doesn't fit, or is more than is left
  while (high <= remaining && fits(high)) {
    low = high;
    high *= 2;
  }
  high = Math.min(high, remaining + 1);
  while (high - low > 1) {
    const middle = Math.floor((low + high) / 2);
    if (fits(middle)) low = middle;
    else high = middle;
  }
  return low;
}

/**
 * `text` broken into lines no wider than `maxWidth`, measured by `measure(line)`.
 * Lines break between words; a word too long for a line of its own is broken
 * between characters. Line breaks in the text are kept, and spaces too, as the
 * editor shows them: at the start of a paragraph they're kept, and where a line
 * breaks they hang off the end of it, unseen.
 */
export function wrapLines(text, maxWidth, measure) {
  const lines = [];
  for (const paragraph of text.split("\n")) {
    let line = null; // null until the line has something on it, even a space
    for (const word of paragraph.split(" ")) {
      const candidate = line === null ? word : `${line} ${word}`;
      if (measure(candidate) <= maxWidth) {
        line = candidate;
        continue;
      }
      if (word === "") continue; // a space where the line breaks
      if (line !== null) lines.push(line);
      line = word;
      if (measure(line) <= maxWidth) continue;
      const characters = charactersOf(word);
      let start = 0;
      while (characters.length - start > 1) {
        const count = charactersThatFit(characters, start, maxWidth, measure);
        if (start + count >= characters.length) break;
        lines.push(characters.slice(start, start + count).join(""));
        start += count;
      }
      line = characters.slice(start).join("");
    }
    lines.push(line ?? "");
  }
  return lines;
}

// Past this many characters, wrapping the text at every size it's tried at gets expensive.
const LONG_TEXT = 400;

// Whether a long text surely needs more lines than fit at `size`, going by how
// wide it is rather than wrapping it: the lines hold all of it but the spaces
// where they break. So a size it can't fit is passed over without wrapping.
function cannotFit(element, size, width, height, measure) {
  if (element.text.length <= LONG_TEXT) return false;
  let lines = 0;
  for (const paragraph of element.text.split("\n")) {
    const letters = measure(paragraph.replaceAll(" ", ""), size, element.font);
    lines += Math.max(1, Math.floor(letters / width));
  }
  return lines * size * LINE_HEIGHT > height;
}

/**
 * Where a note's text goes: `{ fontSize, lines, shown, lineHeight, centerX, top, width, height }`,
 * with `top` the top of the first line. `measure(text, fontSize, font)` gives
 * the width of `text` at that size.
 *
 * Text that doesn't fit even at the smallest size starts at the top of the
 * note, and only the first `shown` lines, those that fit, are drawn.
 */
export function layoutNote(element, measure) {
  const box = normalizeRect(element.x1, element.y1, element.x2, element.y2);
  const pad = Math.min(box.width, box.height) * NOTE_PADDING;
  const width = Math.max(1, box.width - pad * 2);
  const height = Math.max(1, box.height - pad * 2);

  let fontSize = Math.max(MIN_NOTE_FONT_SIZE, Math.round(Math.min(box.width, box.height) / 7));
  let lines;
  let fits;
  for (;;) {
    const size = fontSize;
    if (fontSize > MIN_NOTE_FONT_SIZE && cannotFit(element, size, width, height, measure)) {
      fontSize = Math.max(MIN_NOTE_FONT_SIZE, Math.floor(fontSize * SHRINK));
      continue;
    }
    lines = wrapLines(element.text, width, (line) => measure(line, size, element.font));
    fits = lines.length * fontSize * LINE_HEIGHT <= height;
    if (fits || fontSize <= MIN_NOTE_FONT_SIZE) break;
    fontSize = Math.max(MIN_NOTE_FONT_SIZE, Math.floor(fontSize * SHRINK));
  }
  const lineHeight = fontSize * LINE_HEIGHT;
  return {
    fontSize,
    lines,
    shown: fits ? lines.length : Math.max(1, Math.floor(height / lineHeight)),
    lineHeight,
    centerX: box.x + box.width / 2,
    top: fits ? box.y + box.height / 2 - (lines.length * lineHeight) / 2 : box.y + (box.height - height) / 2,
    width,
    height,
  };
}

// Text width scales with font size, so each piece of text is measured once, at
// a reference size, and scaled.
const REFERENCE_SIZE = 100;
// Lines and words are worth remembering, the pieces of one enormous word that
// wrapping tries one after another are not.
const MAX_REMEMBERED_LENGTH = 120;
const widths = new Map(); // font -> Map(text -> width at REFERENCE_SIZE)
let context;

function measureInCanvas(text, fontSize, font) {
  const key = fontKey(font);
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
    if (text.length <= MAX_REMEMBERED_LENGTH) {
      if (known.size > 20_000) known.clear();
      known.set(text, width);
    }
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
