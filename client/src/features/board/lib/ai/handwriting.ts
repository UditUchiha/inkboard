import type { Element as BoardElement, PenElement, TextElement } from "@inkboard/shared/types";
import { AiError, askModel } from "./askModel";
import type { AiSettings } from "./providers";
import { createElement, getBounds, isFrame, withContents } from "../elements/elements";
import type { ElementStyle } from "../elements/elements";
import { clamp, expandRect, rectsOverlap, unionRects } from "../elements/geometry";
import type { Rect, Size } from "../elements/geometry";
import { renderScene } from "../render/renderer";

// Strokes this close (board units) count as parts of the same thing written.
const NEAR = 40;
// Plenty for handwriting, and inside what vision models read without downscaling.
const PICTURE_SIDE = 1000;
const PICTURE_PADDING = 16;
// One dark ink on white, so colored strokes read as clearly as black ones.
const INK = "#16213a";
// The server's text size range.
const MIN_FONT_SIZE = 8;
const MAX_FONT_SIZE = 400;

const isPen = (element: BoardElement): element is PenElement => element.type === "pen";

// For a stroke, every stroke chained near it, so selecting any part of an equation picks all of it.
export function strokesToRead(board: BoardElement[], selected: BoardElement): PenElement[] {
  if (isFrame(selected)) return withContents(board, selected).filter(isPen);
  if (!isPen(selected)) return [];
  const pens = board.filter(isPen);
  const bounds = new Map(pens.map((pen) => [pen.id, getBounds(pen)]));
  const picked = new Set([selected.id]);
  const unvisited = [getBounds(selected)];
  // shortcut: quadratic in strokes; fine for an equation's few dozen, needs a spatial index past thousands.
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

export function pictureOf(strokes: PenElement[]): string {
  const bounds = unionRects(strokes.map(getBounds))!;
  const width = bounds.width + PICTURE_PADDING * 2;
  const height = bounds.height + PICTURE_PADDING * 2;
  // Small writing is enlarged (up to 4×) so the model sees it clearly.
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

export function answerToLatex(answer: unknown): string {
  const latex = (answer as { latex?: unknown } | null)?.latex;
  if (typeof latex !== "string") throw new AiError("The answer couldn't be read. Try again.");
  return latex
    .trim()
    .replace(/^\$+|\$+$/g, "")
    .trim();
}

export async function readHandwriting({
  settings,
  picture,
  signal,
}: {
  settings: AiSettings;
  picture: string;
  signal: AbortSignal;
}) {
  const { answer, stop } = await askModel({
    settings,
    system: READING_PROMPT,
    text: "Write this handwriting as LaTeX.",
    image: picture,
    schema: EQUATION_SCHEMA,
    signal,
  });
  if (stop !== "done") throw new AiError("The AI won't read that. Try writing it again.");
  const latex = answerToLatex(answer);
  if (!latex)
    throw new AiError("The AI couldn't read maths in that. Select just the equation, or write it more clearly.");
  return latex;
}

// `formula` is the typeset size in ems; until typeset, the equation is sized by the writing's height alone.
export function equationElement(
  latex: string,
  strokes: PenElement[],
  formula: Size | null,
  style: ElementStyle,
): TextElement {
  const area: Rect = unionRects(strokes.map(getBounds))!;
  // A line of maths typeset is about 1.5 ems tall.
  const fits = formula ? Math.min(area.width / formula.width, area.height / formula.height) : area.height / 1.5;
  const fontSize = Math.round(clamp(fits, MIN_FONT_SIZE, MAX_FONT_SIZE));
  const size = formula ? { width: formula.width * fontSize, height: formula.height * fontSize } : area;
  const corner = { x: area.x + (area.width - size.width) / 2, y: area.y + (area.height - size.height) / 2 };
  const text = createElement("text", corner, { ...style, stroke: strokes[0].stroke, fontSize }) as TextElement;
  return { ...text, text: `$$${latex}$$` };
}
