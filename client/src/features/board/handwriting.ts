import type { Element as BoardElement, PenElement, TextElement } from "@inkboard/shared/types";
import { AiDrawError, askClaude, readAnswer } from "./aiDraw";
import { createElement, getBounds, isFrame, withContents } from "./elements";
import type { ElementStyle } from "./elements";
import { clamp, expandRect, rectsOverlap, unionRects } from "./geometry";
import type { Rect, Size } from "./geometry";
import { renderScene } from "./renderer";

// Handwriting to equations: maths written with the pen is pictured and sent to Claude, which reads it as LaTeX, the
// same way and with the same key as drawing with AI (aiDraw.ts). The person checks it, then the strokes are replaced
// by an equation (a text written as $$…$$, see math.ts) the size of what they wrote.

// Strokes this close (in board units) to one another are taken to be parts of the same thing written.
const NEAR = 40;
// The longer side of the picture sent, in pixels: plenty for handwriting, and well inside what Claude reads whole.
const PICTURE_SIDE = 1000;
const PICTURE_PADDING = 16;
// Every stroke is pictured in one dark ink on white, whatever color it was written in.
const INK = "#16213a";
// The sizes a text can be (as the server allows).
const MIN_FONT_SIZE = 8;
const MAX_FONT_SIZE = 400;

const isPen = (element: BoardElement): element is PenElement => element.type === "pen";

/**
 * The strokes to read for `selected`: the strokes in it, for a frame; for a stroke, it and every stroke written near
 * it (near one near it, and so on), so selecting any part of an equation picks all of it. In board order.
 */
export function strokesToRead(board: BoardElement[], selected: BoardElement): PenElement[] {
  if (isFrame(selected)) return withContents(board, selected).filter(isPen);
  if (!isPen(selected)) return [];
  const pens = board.filter(isPen);
  const bounds = new Map(pens.map((pen) => [pen.id, getBounds(pen)]));
  const picked = new Set([selected.id]);
  const unvisited = [getBounds(selected)];
  // shortcut: compares each picked stroke with every stroke on the board; fine for an equation's few dozen strokes,
  // worth a spatial index if boards covered in thousands of connected strokes make it slow.
  for (let area = unvisited.pop(); area; area = unvisited.pop()) {
    const near = expandRect(area, NEAR);
    for (const pen of pens) {
      const box = bounds.get(pen.id)!;
      if (!picked.has(pen.id) && rectsOverlap(near, box)) {
        picked.add(pen.id);
        unvisited.push(box);
      }
    }
  }
  return pens.filter((pen) => picked.has(pen.id));
}

/** A picture of `strokes` (at least one), dark on white and cropped close, as a PNG data URL. */
export function pictureOf(strokes: PenElement[]): string {
  // The assertion: there's a stroke, so there are bounds.
  const bounds = unionRects(strokes.map(getBounds))!;
  const width = bounds.width + PICTURE_PADDING * 2;
  const height = bounds.height + PICTURE_PADDING * 2;
  // Small writing is enlarged (up to 4 times) so Claude sees it clearly; big writing is shrunk to fit.
  const scale = Math.min(4, PICTURE_SIDE / Math.max(width, height));
  const canvas = document.createElement("canvas");
  canvas.width = Math.ceil(width * scale);
  canvas.height = Math.ceil(height * scale);
  renderScene(canvas, {
    elements: strokes.map((stroke) => ({ ...stroke, stroke: INK })),
    viewport: { x: PICTURE_PADDING - bounds.x, y: PICTURE_PADDING - bounds.y, zoom: 1 },
    dpr: scale,
    background: "#ffffff",
  });
  return canvas.toDataURL("image/png");
}

/** What Claude must answer with: the LaTeX, or "" when there's no maths it can read. */
export const EQUATION_SCHEMA = {
  type: "object",
  additionalProperties: false,
  required: ["latex"],
  properties: { latex: { type: "string" } },
};

export const READING_PROMPT = `You read handwritten maths from a whiteboard. You're given a picture of pen strokes, dark on white, and you answer with the LaTeX that typesets exactly what is written.

- Write what's there: don't solve, simplify, finish or correct it.
- Use math-mode LaTeX that MathJax understands, without $ signs or \\[ \\] around it.
- For several lines, put them in \\begin{aligned} … \\end{aligned}, with \\\\ between lines and & before the signs that line up.
- If the picture isn't maths, or you can't make out what it says, answer with an empty latex.`;

/** The message sent to Claude for a picture, a PNG data URL made by pictureOf. */
export function readingRequest(picture: string) {
  return [
    {
      type: "image" as const,
      source: {
        type: "base64" as const,
        media_type: "image/png" as const,
        data: picture.slice(picture.indexOf(",") + 1),
      },
    },
    { type: "text" as const, text: "Write this handwriting as LaTeX." },
  ];
}

/** The LaTeX in Claude's answer, without any $ signs around it; "" when Claude couldn't read the writing. */
export function answerToLatex(answer: unknown): string {
  const latex = (answer as { latex?: unknown } | null)?.latex;
  if (typeof latex !== "string") throw new AiDrawError("Claude's answer couldn't be read. Try again.");
  return latex
    .trim()
    .replace(/^\$+|\$+$/g, "")
    .trim();
}

/**
 * Asks Claude to read the handwriting in `picture` (made by pictureOf) as LaTeX, with the person's own `key`.
 * Rejects with an AiDrawError to show the person, or an AbortError when `signal` cancels it.
 */
export async function readHandwriting({ key, picture, signal }: { key: string; picture: string; signal: AbortSignal }) {
  const response = await askClaude({
    key,
    system: READING_PROMPT,
    content: readingRequest(picture),
    schema: EQUATION_SCHEMA,
    signal,
  });
  if (response.stop_reason === "refusal") throw new AiDrawError("Claude won't read that. Try writing it again.");
  const latex = answerToLatex(readAnswer(response));
  if (!latex) {
    throw new AiDrawError("Claude couldn't read maths in that. Select just the equation, or write it more clearly.");
  }
  return latex;
}

/**
 * The equation for `latex` that replaces `strokes`: in their color, and as big as fits where they were, centred
 * there. `formula` is its typeset size in ems (see math.ts); until it's typeset, it's sized by its height alone.
 */
export function equationElement(
  latex: string,
  strokes: PenElement[],
  formula: Size | null,
  style: ElementStyle,
): TextElement {
  // The assertion: there are strokes to replace, so there are bounds.
  const area: Rect = unionRects(strokes.map(getBounds))!;
  // A line of maths typeset is about 1.5 ems tall.
  const fits = formula ? Math.min(area.width / formula.width, area.height / formula.height) : area.height / 1.5;
  const fontSize = Math.round(clamp(fits, MIN_FONT_SIZE, MAX_FONT_SIZE));
  const size = formula ? { width: formula.width * fontSize, height: formula.height * fontSize } : area;
  const corner = { x: area.x + (area.width - size.width) / 2, y: area.y + (area.height - size.height) / 2 };
  // The cast: createElement makes a text when asked for one.
  const text = createElement("text", corner, { ...style, stroke: strokes[0].stroke, fontSize }) as TextElement;
  return { ...text, text: `$$${latex}$$` };
}
