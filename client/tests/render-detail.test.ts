import assert from "node:assert/strict";
import { describe, it } from "node:test";
import type { Element } from "@inkboard/shared/types";

// Text is measured with a canvas, which Node doesn't have: a stand-in makes every character 10 wide.
(globalThis as unknown as { document: unknown }).document = {
  createElement: () => ({
    getContext: () => ({ font: "", measureText: (text: string) => ({ width: text.length * 10 }) }),
  }),
  fonts: { load: async () => {} },
};
const { renderScene } = await import("../src/features/board/renderer.ts");

// A 2D context that records which methods were called and which properties were set, and does nothing else.
function recordingCanvas() {
  const calls: string[] = [];
  let zoom = 1;
  const ctx = new Proxy({} as Record<string | symbol, unknown>, {
    get: (target, key) =>
      key in target
        ? target[key]
        : (...args: number[]) => {
            calls.push(String(key));
            if (key === "setTransform") zoom = args[0];
            if (key === "getTransform") return { a: zoom, b: 0 };
            if (key === "measureText") return { width: 10 };
            return undefined;
          },
    set: (target, key, value) => {
      if (key === "shadowBlur") calls.push("shadowBlur");
      target[key] = value;
      return true;
    },
  });
  return { canvas: { width: 800, height: 600, getContext: () => ctx } as unknown as HTMLCanvasElement, calls };
}

const elements = [
  { id: "n", type: "sticky", x1: 0, y1: 0, x2: 200, y2: 200, text: "Buy milk", fill: "#fff3bf", font: "hand" },
  { id: "t", type: "text", x1: 300, y1: 0, text: "Heading", stroke: "#1e1e1e", fontSize: 24, font: "hand" },
] as unknown as Element[];

const render = (zoom: number) => {
  const { canvas, calls } = recordingCanvas();
  renderScene(canvas, { elements, viewport: { x: 0, y: 0, zoom } });
  return calls;
};

describe("drawing zoomed far out", () => {
  it("writes text that can be read, with a note's shadow", () => {
    const calls = render(1);
    assert.equal(calls.filter((call) => call === "fillText").length, 2, "the note's text and the heading");
    assert.ok(calls.includes("shadowBlur"));
  });

  it("leaves out text too small to read, and a note's shadow too small to see, keeping a bar for the text", () => {
    const calls = render(0.05);
    assert.equal(calls.filter((call) => call === "fillText").length, 0);
    assert.ok(!calls.includes("shadowBlur"));
    assert.equal(calls.filter((call) => call === "fillRect").length, 2, "the note itself, and the heading as a bar");
  });
});
