import { ApiElementError, fromApiElement, toApiElement } from "@inkboard/shared/api-elements";
import type { Element as BoardElement } from "@inkboard/shared/types";
import { getBounds } from "./elements";
import { rectsOverlap } from "./geometry";
import type { Rect } from "./geometry";

// Drawing with AI: someone describes what they want, Claude answers with elements in the public API's form
// (shared/src/api-elements.ts), and they're added to the board as one undo step. It runs in the browser with the
// person's own Anthropic key, which is kept only in this browser and sent only to Anthropic.

export const AI_MODEL = "claude-opus-5-5";
const KEY_STORAGE = "inkboard.anthropicKey";
// Past this many, only what's in view is described to Claude, so the request stays a sensible size.
const MAX_CONTEXT_ELEMENTS = 300;

/** Why drawing with AI didn't work, in a sentence for the person. */
export class AiDrawError extends Error {}

export function readAiKey(): string {
  try {
    return localStorage.getItem(KEY_STORAGE) ?? "";
  } catch {
    return "";
  }
}

export function saveAiKey(key: string) {
  try {
    if (key) localStorage.setItem(KEY_STORAGE, key);
    else localStorage.removeItem(KEY_STORAGE);
  } catch {
    // Storage blocked: the key works until the page is closed.
  }
}

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

/** What Claude must answer with: the elements to add, or to change on the board. */
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

/** The part of the board described to Claude: all of it, or for a big board, what's in `view`. */
export function boardContext(elements: BoardElement[], view: Rect) {
  const shown =
    elements.length <= MAX_CONTEXT_ELEMENTS
      ? elements
      : elements.filter((element) => rectsOverlap(getBounds(element), view));
  return shown.slice(0, MAX_CONTEXT_ELEMENTS).map(toApiElement);
}

/** The message sent to Claude for `request`. */
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

/**
 * The board elements Claude's answer makes: new ones, and ones on the board with its changes. Elements that can't
 * be drawn (a line to nothing, say) are left out and counted in `skipped`.
 */
export function answerToElements(answer: unknown, board: BoardElement[]) {
  const inputs = (answer as { elements?: unknown } | null)?.elements;
  if (!Array.isArray(inputs)) throw new AiDrawError("Claude's answer couldn't be read. Try again.");
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

/**
 * Asks Claude to draw `request` on the board, with the person's own `key`. Resolves to the elements to commit.
 * Rejects with an AiDrawError to show the person, or an AbortError when `signal` cancels it.
 */
export async function drawWithAi({
  key,
  request,
  board,
  view,
  signal,
}: {
  key: string;
  request: string;
  board: BoardElement[];
  view: Rect;
  signal: AbortSignal;
}) {
  // Loaded only when someone draws with AI, not with every board.
  const { default: Anthropic } = await import("@anthropic-ai/sdk");
  // The key is the person's own, typed into this browser for this, so it's meant to be used from here.
  const client = new Anthropic({ apiKey: key, dangerouslyAllowBrowser: true });
  let response;
  try {
    response = await client.beta.messages.create(
      {
        model: AI_MODEL,
        max_tokens: 16000,
        // If Claude's safeguards decline, Anthropic's recommended fallback model answers instead.
        betas: ["server-side-fallback-2026-07-01"],
        fallbacks: "default",
        output_config: { effort: "medium", format: { type: "json_schema", schema: OUTPUT_SCHEMA } },
        system: SYSTEM_PROMPT,
        messages: [{ role: "user", content: requestMessage(request, board, view) }],
      },
      { signal },
    );
  } catch (error) {
    if (error instanceof Anthropic.APIUserAbortError) throw new DOMException("Cancelled", "AbortError");
    if (error instanceof Anthropic.AuthenticationError) {
      throw new AiDrawError("Anthropic didn't accept that key. Check it, or make a new one.");
    }
    if (error instanceof Anthropic.PermissionDeniedError) {
      throw new AiDrawError("That key isn't allowed to use Claude. Check its workspace in the Anthropic Console.");
    }
    if (error instanceof Anthropic.RateLimitError) {
      throw new AiDrawError("Your Anthropic account has reached a limit for now. Wait a moment, or check its billing.");
    }
    if (error instanceof Anthropic.BadRequestError)
      throw new AiDrawError(`Anthropic refused the request: ${error.message}`);
    if (error instanceof Anthropic.APIConnectionError) {
      throw new AiDrawError("Couldn't reach Anthropic. Check your connection and try again.");
    }
    if (error instanceof Anthropic.APIError) throw new AiDrawError("Anthropic had a problem. Try again in a moment.");
    throw error;
  }

  if (response.stop_reason === "refusal") {
    throw new AiDrawError("Claude won't draw that. Try describing it another way.");
  }
  if (response.stop_reason === "max_tokens") {
    throw new AiDrawError("That's more than fits in one go. Ask for a smaller part of it.");
  }
  const text = response.content.find((block) => block.type === "text")?.text;
  let answer: unknown;
  try {
    answer = JSON.parse(text ?? "");
  } catch {
    throw new AiDrawError("Claude's answer couldn't be read. Try again.");
  }
  return answerToElements(answer, board);
}
