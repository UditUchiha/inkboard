import type { Font, StickyElement } from "@inkboard/shared/types";
import { FONTS, LINE_HEIGHT, fontKey } from "../../constants/board";
import { normalizeRect } from "./geometry";

export type MeasureNote = (text: string, fontSize: number, font: Font) => number;

export type NoteLayout = {
  fontSize: number;
  lines: string[];
  shown: number;
  lineHeight: number;
  centerX: number;
  top: number;
  width: number;
  height: number;
};

// Wrapped to the note's width, centered and as large as fits; everything that draws a note uses this so it looks the same everywhere.

export const NOTE_PADDING = 0.09; // of the note's shorter side, on every edge
export const MIN_NOTE_FONT_SIZE = 6;
const SHRINK = 0.9;

// Whole characters as people see them, so a break never splits an emoji, a flag or an accented letter.
const segmenter =
  typeof Intl !== "undefined" && Intl.Segmenter ? new Intl.Segmenter(undefined, { granularity: "grapheme" }) : null;
export const charactersOf = (word: string): string[] =>
  segmenter ? Array.from(segmenter.segment(word), (part) => part.segment) : Array.from(word);

// Doubles until a length doesn't fit, then halves back: measures a line a few times, never the leftover word.
function charactersThatFit(
  characters: string[],
  start: number,
  maxWidth: number,
  measure: (text: string) => number,
): number {
  const remaining = characters.length - start;
  const fits = (count: number) => measure(characters.slice(start, start + count).join("")) <= maxWidth;
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

// Breaks between words, or between characters for a word too long for a line. Spaces are kept as the editor
// shows them: at a paragraph start, and hanging unseen off a line end.
export function wrapLines(text: string, maxWidth: number, measure: (text: string) => number): string[] {
  const lines: string[] = [];
  for (const paragraph of text.split("\n")) {
    let line: string | null = null; // null until the line has something on it, even a space
    for (const word of paragraph.split(" ")) {
      const candidate: string = line === null ? word : `${line} ${word}`;
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

// By width alone, a long text that surely needs more lines than fit is passed over without wrapping.
function cannotFit(element: StickyElement, size: number, width: number, height: number, measure: MeasureNote): boolean {
  if (element.text.length <= LONG_TEXT) return false;
  let lines = 0;
  for (const paragraph of element.text.split("\n")) {
    const letters = measure(paragraph.replaceAll(" ", ""), size, element.font);
    lines += Math.max(1, Math.floor(letters / width));
  }
  return lines * size * LINE_HEIGHT > height;
}

// Text that doesn't fit even at the smallest size starts at the top, and only the `shown` lines that fit are drawn.
export function layoutNote(element: StickyElement, measure: MeasureNote): NoteLayout {
  const box = normalizeRect(element.x1, element.y1, element.x2, element.y2);
  const pad = Math.min(box.width, box.height) * NOTE_PADDING;
  const width = Math.max(1, box.width - pad * 2);
  const height = Math.max(1, box.height - pad * 2);

  let fontSize = Math.max(MIN_NOTE_FONT_SIZE, Math.round(Math.min(box.width, box.height) / 7));
  let lines: string[];
  let fits: boolean;
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

// Text width scales with font size, so each text is measured once at a reference size.
const REFERENCE_SIZE = 100;
// Lines and words are worth remembering; the pieces of one enormous word that wrapping tries are not.
const MAX_REMEMBERED_LENGTH = 120;
const widths = new Map<Font, Map<string, number>>(); // font -> Map(text -> width at REFERENCE_SIZE)
let context: CanvasRenderingContext2D; // made on first use

function measureInCanvas(text: string, fontSize: number, font: Font) {
  const key = fontKey(font);
  let known = widths.get(key);
  if (!known) {
    known = new Map();
    widths.set(key, known);
  }
  let width = known.get(text);
  if (width === undefined) {
    context ??= document.createElement("canvas").getContext("2d")!; // a canvas always gives a 2D context
    context.font = `${REFERENCE_SIZE}px ${FONTS[key].family}`;
    width = context.measureText(text).width;
    if (text.length <= MAX_REMEMBERED_LENGTH) {
      if (known.size > 20_000) known.clear();
      known.set(text, width);
    }
  }
  return (width * fontSize) / REFERENCE_SIZE;
}

let layouts = new WeakMap<StickyElement, NoteLayout>();

export function noteLayout(element: StickyElement): NoteLayout {
  let layout = layouts.get(element);
  if (!layout) {
    layout = layoutNote(element, measureInCanvas);
    layouts.set(element, layout);
  }
  return layout;
}

export function forgetNoteMeasurements() {
  widths.clear();
  layouts = new WeakMap();
}
