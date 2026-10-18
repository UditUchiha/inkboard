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
const { createTileCache } = await import("../src/features/board/zoomedOutCache.ts");

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

const box = {
  id: "r",
  type: "rectangle",
  seed: 5,
  x1: 0,
  y1: 0,
  x2: 200,
  y2: 120,
  stroke: "#1e1e1e",
  fill: null,
  strokeWidth: 2,
  sketchy: true,
} as unknown as Element;

describe("drawing small shapes plainly", () => {
  const draw = (zoom: number) => {
    const { canvas, calls } = recordingCanvas();
    renderScene(canvas, { elements: [box], viewport: { x: 0, y: 0, zoom } });
    return calls;
  };

  it("draws a sketchy shape with Rough.js while it is big enough to see", () => {
    assert.ok(draw(1).includes("bezierCurveTo"));
  });

  it("draws it as a plain path once it is small", () => {
    const calls = draw(0.05);
    assert.ok(!calls.includes("bezierCurveTo"));
    assert.equal(calls.filter((call) => call === "rect").length, 1);
    assert.equal(calls.filter((call) => call === "stroke").length, 1);
  });

  it("draws a small triangle or diamond by its corners, not as a box", () => {
    for (const type of ["triangle", "diamond"]) {
      const { canvas, calls } = recordingCanvas();
      renderScene(canvas, { elements: [{ ...box, type } as Element], viewport: { x: 0, y: 0, zoom: 0.05 } });
      assert.ok(!calls.includes("rect"), type);
      assert.ok(calls.includes("closePath"), type);
    }
  });
});

describe("drawing the board from tiles", () => {
  // A stand-in for the canvas a tile is drawn on, which Node doesn't have: it records what is drawn on it.
  let taken = 0; // how many tiles have been drawn
  (globalThis as unknown as { OffscreenCanvas: unknown }).OffscreenCanvas = class {
    getContext = recordingCanvas().canvas.getContext;
    transferToImageBitmap() {
      taken += 1;
      return { close() {} };
    }
  };
  const viewport = (x = 0) => ({ x, y: 0, zoom: 0.1 });
  const make = () => {
    const { canvas, calls } = recordingCanvas();
    const tiles = createTileCache<{ bitmap: ImageBitmap; pictures: ReadonlySet<string> }>();
    const render = (options: Partial<Parameters<typeof renderScene>[1]> = {}) => {
      calls.length = 0;
      renderScene(canvas, { elements: [box], viewport: viewport(), tiles, ...options });
      return calls.slice();
    };
    return render;
  };

  it("draws the first frame at a zoom outright, since a zoom gesture only passes through it", () => {
    const render = make();
    taken = 0;
    assert.ok(!render().includes("drawImage"));
    assert.equal(taken, 0);
  });

  it("then copies tiles, and a pan draws nothing again", () => {
    const render = make();
    render();
    taken = 0;
    assert.ok(render().includes("drawImage"));
    assert.equal(taken, 4, "the 2 by 2 tiles an 800 by 600 canvas takes");
    const panned = render({ viewport: viewport(-40) });
    assert.ok(panned.includes("drawImage"));
    assert.equal(taken, 4, "no tile is drawn again");
  });

  it("draws a tile again only when an element in it changes", () => {
    const render = make();
    render();
    render();
    taken = 0;
    const wider = { ...box, x2: 300 } as Element;
    render({ elements: [wider] });
    assert.equal(taken, 1);
    // A change far off the screen is left for when it comes into view: no tile is drawn for it now.
    render({ elements: [wider, { ...box, id: "far", x1: 90_000, x2: 90_200 } as Element] });
    assert.equal(taken, 1);
  });

  it("draws outright a scene a tile can't hold", () => {
    const render = make();
    render();
    render();
    assert.ok(!render({ hiddenId: "r" }).includes("drawImage"), "a text being edited");
    assert.ok(!render({ background: "#fff" }).includes("drawImage"));
    assert.ok(!render({ viewport: { x: 0, y: 0, zoom: 1 } }).includes("drawImage"), "not zoomed out");
  });

  it("draws the selection over the tiles", () => {
    const render = make();
    render();
    render();
    const calls = render({ selectedId: "r" });
    assert.ok(calls.lastIndexOf("strokeRect") > calls.lastIndexOf("drawImage"), "the selection's dashed box");
  });
});
