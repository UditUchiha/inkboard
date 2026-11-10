import { ApiElementError, fromApiElement, toApiElement } from "@inkboard/shared/api-elements";
import type { Element as BoardElement } from "@inkboard/shared/types";
import { AiError, askModel } from "./askModel";
import type { AiSettings } from "./providers";
import { getBounds } from "../elements/elements";
import { rectsOverlap } from "../elements/geometry";
import type { Rect } from "../elements/geometry";

// The model answers in the public API's element form, so its output is validated like any API write.

// Past this many, only what's in view is described, so the request stays a sensible size.
const MAX_CONTEXT_ELEMENTS = 300;

const number = { type: "number" };
const ELEMENT_SCHEMA = {
  type: "object",
  additionalProperties: false,
  required: ["id", "type"],
  properties: {
    id: { type: "string" },
    type: {
      type: "string",
      enum: ["rectangle", "ellipse", "triangle", "diamond", "sticky", "text", "frame", "arrow", "line"],
    },
    x: number,
    y: number,
    width: number,
    height: number,
    x1: number,
    y1: number,
    x2: number,
    y2: number,
    from: { type: "string" },
    to: { type: "string" },
    text: { type: "string" },
    name: { type: "string" },
    fill: { type: "string" },
    stroke: { type: "string" },
    fontSize: number,
    route: { type: "string", enum: ["straight", "curved", "elbow"] },
  },
};

export const OUTPUT_SCHEMA = {
  type: "object",
  additionalProperties: false,
  required: ["elements"],
  properties: { elements: { type: "array", items: ELEMENT_SCHEMA } },
};

export const SYSTEM_PROMPT = `You draw on Inkboard, a collaborative whiteboard. You're given what's on the board and the area the person is looking at, and you answer with elements to add, or to change.

Elements:
- rectangle, ellipse, triangle, diamond: x, y, width, height (top left corner and size). Optional stroke, fill (hex colors). A diamond is a flowchart's decision; a triangle points up.
- sticky (a sticky note): x, y, width, height, text, optional fill. Usually 200 by 200.
- text: x, y (its top left), text, optional fontSize (default 32; 20 to 24 suits labels). A text that is all LaTeX between $$ signs, like "$$E = mc^2$$", is drawn as a typeset equation.
- frame (a named area that groups what's inside it): x, y, width, height, name.
- arrow, line: from and to, the ids of the elements their ends attach to; or x1, y1, x2, y2 for loose ends. Optional text (a label) and route: straight, curved or elbow.

Coordinates are board units; y grows downwards. A shape holding a short label is about 180 by 80, with the label as the shape's own text if it's a sticky, otherwise as a text element placed inside it.

How to draw:
- Lay things out tidily: aligned rows or columns, even gaps of 40 to 80, nothing overlapping unless one thing is meant to sit inside another.
- Put new content in the visible area if there's room there; otherwise next to what's already on the board, not on top of it.
- Give every new element a short, unique id starting with "ai-", so arrows can refer to it.
- To change an element already on the board, send its id with only the fields to change. Leave out elements you don't change.
- Use a few calm colors, such as #ffec99, #b2f2bb, #a5d8ff, #ffc9c9 for sticky notes and fills, and #16213a for lines and text.
- Draw what was asked, completely, and nothing else.`;

export function boardContext(elements: BoardElement[], view: Rect) {
  const shown =
    elements.length <= MAX_CONTEXT_ELEMENTS
      ? elements
      : elements.filter((element) => rectsOverlap(getBounds(element), view));
  return shown.slice(0, MAX_CONTEXT_ELEMENTS).map(toApiElement);
}

export function requestMessage(request: string, elements: BoardElement[], view: Rect) {
  const area = {
    x: Math.round(view.x),
    y: Math.round(view.y),
    width: Math.round(view.width),
    height: Math.round(view.height),
  };
  return [
    `Visible area: ${JSON.stringify(area)}`,
    `On the board: ${JSON.stringify(boardContext(elements, view))}`,
    `Request: ${request}`,
  ].join("\n\n");
}

// Elements that can't be drawn (a line to nothing, say) are skipped and counted.
export function answerToElements(answer: unknown, board: BoardElement[]) {
  const inputs = (answer as { elements?: unknown } | null)?.elements;
  if (!Array.isArray(inputs)) throw new AiError("The answer couldn't be read. Try again.");
  const onBoard = new Map(board.map((element) => [element.id, element]));
  const made = new Map<string, BoardElement>();
  const find = (id: string) => made.get(id) ?? onBoard.get(id);
  let skipped = 0;
  // Shapes first, so lines and arrows find what they attach to whatever order they came in.
  const ordered = [...inputs].sort((a, b) => Number(isConnector(a)) - Number(isConnector(b)));
  for (const input of ordered) {
    try {
      const id = (input as { id?: unknown }).id;
      const element = fromApiElement(input, typeof id === "string" ? onBoard.get(id) : undefined, find, "Element");
      made.set(element.id, element);
    } catch (error) {
      if (!(error instanceof ApiElementError)) throw error;
      skipped += 1;
    }
  }
  return { elements: [...made.values()], skipped };
}

const isConnector = (input: unknown) => {
  const type = (input as { type?: unknown } | null)?.type;
  return type === "arrow" || type === "line";
};

export async function drawWithAi({
  settings,
  request,
  board,
  view,
  signal,
}: {
  settings: AiSettings;
  request: string;
  board: BoardElement[];
  view: Rect;
  signal: AbortSignal;
}) {
  const { answer, stop } = await askModel({
    settings,
    system: SYSTEM_PROMPT,
    text: requestMessage(request, board, view),
    schema: OUTPUT_SCHEMA,
    signal,
  });
  if (stop === "refusal") throw new AiError("The AI won't draw that. Try describing it another way.");
  if (stop === "too-long") throw new AiError("That's more than fits in one go. Ask for a smaller part of it.");
  return answerToElements(answer, board);
}
