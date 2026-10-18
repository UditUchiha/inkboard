import assert from "node:assert/strict";
import { afterEach, describe, it } from "node:test";
import type { Element, FrameElement, PenElement, ShapeElement } from "@inkboard/shared/types";
import { AI_MODEL } from "../src/features/board/aiDraw.ts";
import { getBounds } from "../src/features/board/elements.ts";
import { unionRects } from "../src/features/board/geometry.ts";
import {
  answerToLatex,
  EQUATION_SCHEMA,
  equationElement,
  readHandwriting,
  readingRequest,
  strokesToRead,
} from "../src/features/board/handwriting.ts";

// A short stroke from (x, y) to 20 to the right and 30 down.
const stroke = (id: string, x: number, y: number, color = "#1971c2"): PenElement => ({
  id,
  type: "pen",
  points: [
    [x, y, 0.5],
    [x + 20, y + 30, 0.5],
  ],
  pressure: false,
  stroke: color,
  penSize: 4,
});
const frame: FrameElement = { id: "f", type: "frame", x1: -50, y1: -50, x2: 300, y2: 200, name: "Question 1" };
const box = { id: "box", type: "rectangle", x1: 10, y1: 10, x2: 50, y2: 50, stroke: "#000", strokeWidth: 2 };
const style = { stroke: "#16213a", penSize: 4, fontSize: 32, font: "hand" as const };
const ids = (elements: Element[]) => elements.map((element) => element.id);

describe("picking the handwriting to read", () => {
  // x = 1, written in four strokes along a line, and a separate note further down.
  const board: Element[] = [
    stroke("x1", 0, 0),
    stroke("x2", 30, 0),
    stroke("eq", 90, 10),
    stroke("one", 150, 0),
    stroke("far", 0, 400),
    box as ShapeElement,
  ];

  it("takes a stroke with every stroke written near it, one after another", () => {
    assert.deepEqual(ids(strokesToRead(board, board[0])), ["x1", "x2", "eq", "one"]);
    assert.deepEqual(ids(strokesToRead(board, board[4])), ["far"]);
  });

  it("takes the strokes inside a selected frame, and nothing for other elements", () => {
    assert.deepEqual(ids(strokesToRead([frame, ...board], frame)), ["x1", "x2", "eq", "one"]);
    assert.deepEqual(strokesToRead(board, board[5]), []);
  });
});

describe("asking Claude", () => {
  it("sends the picture as a PNG, before saying what to do with it", () => {
    const [image, text] = readingRequest("data:image/png;base64,iVBORw0KGgo=");
    assert.deepEqual(image, {
      type: "image",
      source: { type: "base64", media_type: "image/png", data: "iVBORw0KGgo=" },
    });
    assert.equal(text.type, "text");
  });

  it("reads the LaTeX from the answer, without $ signs, and empty when there was nothing to read", () => {
    assert.equal(answerToLatex({ latex: " $$x^2 + 1$$ " }), "x^2 + 1");
    assert.equal(answerToLatex({ latex: String.raw`\frac{a}{b}` }), String.raw`\frac{a}{b}`);
    assert.equal(answerToLatex({ latex: "" }), "");
    assert.throws(() => answerToLatex({ text: "x" }), /couldn't be read/);
    assert.deepEqual(EQUATION_SCHEMA.required, ["latex"]);
  });

  describe("over the network", () => {
    const realFetch = globalThis.fetch;
    afterEach(() => {
      globalThis.fetch = realFetch;
    });
    // Answers every request with `body` and `status`, and keeps the requests' bodies.
    function answer(status: number, body: unknown) {
      const sent: Record<string, unknown>[] = [];
      globalThis.fetch = async (_url, init) => {
        sent.push(JSON.parse(String(init?.body)));
        return new Response(JSON.stringify(body), { status, headers: { "content-type": "application/json" } });
      };
      return sent;
    }
    const message = (text: string, stopReason = "end_turn") => ({
      id: "msg_1",
      type: "message",
      role: "assistant",
      model: AI_MODEL,
      content: [{ type: "text", text }],
      stop_reason: stopReason,
      usage: { input_tokens: 1, output_tokens: 1 },
    });
    const read = () =>
      readHandwriting({
        key: "sk-ant-test",
        picture: "data:image/png;base64,AAAA",
        signal: new AbortController().signal,
      });

    it("asks for LaTeX in the schema, with the picture, and gives back what Claude read", async () => {
      const sent = answer(200, message('{"latex":"E = mc^2"}'));
      assert.equal(await read(), "E = mc^2");
      const body = sent[0] as {
        model: string;
        output_config: { format: { schema: unknown } };
        messages: { content: { type: string }[] }[];
      };
      assert.equal(body.model, AI_MODEL);
      assert.deepEqual(body.output_config.format.schema, EQUATION_SCHEMA);
      assert.deepEqual(
        body.messages[0].content.map((block) => block.type),
        ["image", "text"],
      );
    });

    it("says so when Claude couldn't read it, or wouldn't", async () => {
      answer(200, message('{"latex":""}'));
      await assert.rejects(read(), /couldn't read maths/);
      answer(200, message("", "refusal"));
      await assert.rejects(read(), /won't read that/);
    });

    it("says so when Anthropic doesn't accept the key", async () => {
      answer(401, { type: "error", error: { type: "authentication_error", message: "invalid x-api-key" } });
      await assert.rejects(read(), /didn't accept that key/);
    });
  });
});

describe("placing the equation", () => {
  const strokes = [stroke("a", 100, 100, "#e03131"), stroke("b", 300, 100)];
  // The assertion: there are strokes. About 230 across and 40 down.
  const area = unionRects(strokes.map(getBounds))!;
  // A typeset formula 4 ems wide and 1 tall, as math.ts measures them.
  const formula = { width: 4, height: 1 };

  it("fits the equation where the strokes were, centred, in their color", () => {
    const equation = equationElement("x^2", strokes, formula, style);
    assert.equal(equation.text, "$$x^2$$");
    assert.equal(equation.stroke, "#e03131");
    // As tall as the writing, since that's narrow enough, and in the middle of it across.
    assert.equal(equation.fontSize, Math.round(area.height));
    assert.equal(equation.x1, area.x + (area.width - 4 * equation.fontSize) / 2);
    assert.equal(equation.y1, area.y + (area.height - equation.fontSize) / 2);
  });

  it("is sized by the writing's height until the formula is typeset, and never smaller than text can be", () => {
    assert.equal(equationElement("x", strokes, null, style).fontSize, Math.round(area.height / 1.5));
    const dot = [{ ...stroke("dot", 0, 0), points: [[0, 0, 0.5]] }] as PenElement[];
    assert.equal(equationElement("x", dot, formula, style).fontSize, 8);
  });
});
