import assert from "node:assert/strict";
import { describe, it } from "node:test";

// Text is measured with a canvas, which Node doesn't have: a stand-in that makes
// every character 10 units wide is enough for these tests.
globalThis.document ??= {
  createElement: () => ({ getContext: () => ({ font: "", measureText: (text) => ({ width: text.length * 10 }) }) }),
};

const { buildSvg, fontsUsed, SVG_PADDING } = await import("../src/features/board/svgExport.js");
const { BoardFileError, makeBoardFile, parseBoardFile, placeElements } = await import("../src/features/board/boardFile.js");
const { getSceneBounds } = await import("../src/features/board/elements.js");
const { toOperations } = await import("../src/features/board/store.js");

const rect = (id, x = 0, y = 0, extra = {}) => ({
  id,
  type: "rectangle",
  seed: 7,
  x1: x,
  y1: y,
  x2: x + 100,
  y2: y + 50,
  stroke: "#e03131",
  fill: "#ffc9c9",
  strokeWidth: 2.5,
  sketchy: false,
  ...extra,
});
const pen = { id: "p", type: "pen", points: [[0, 0, 0.5], [20, 10, 0.5], [40, 0, 0.5], [60, 15, 0.5]], pressure: false, stroke: "#1971c2", penSize: 8 };
const text = { id: "t", type: "text", x1: 10, y1: 200, text: "Fish & <chips>\nline two", stroke: "#16213a", fontSize: 20, font: "sans" };
const picture = { id: "i", type: "image", imageId: "a".repeat(32), x1: 200, y1: 0, x2: 300, y2: 80 };

describe("SVG export", () => {
  it("draws nothing for an empty board", () => {
    assert.equal(buildSvg([]), null);
  });

  it("frames the drawing with padding, on a white background", () => {
    const svg = buildSvg([rect("r", 10, 20)]);
    const bounds = getSceneBounds([rect("r", 10, 20)]);
    const viewBox = [bounds.x - SVG_PADDING, bounds.y - SVG_PADDING, bounds.width + SVG_PADDING * 2, bounds.height + SVG_PADDING * 2];
    assert.match(svg, new RegExp(`viewBox="${viewBox.map((n) => Math.round(n * 100) / 100).join(" ")}"`));
    assert.match(svg, /<rect [^>]*fill="#ffffff"\/>/);
    assert.ok(svg.startsWith('<svg xmlns="http://www.w3.org/2000/svg"'));
  });

  it("draws shapes as the canvas does, in their stored colors", () => {
    const svg = buildSvg([rect("r")]);
    assert.match(svg, /<path d="M[^"]+" stroke="#e03131" stroke-width="2.5" fill="none"\/>/);
    assert.match(svg, /fill="#ffc9c9"/);
  });

  it("draws pen strokes as filled outlines", () => {
    assert.match(buildSvg([pen]), /<path d="M[^"]+Z" fill="#1971c2"\/>/);
  });

  it("writes text line by line, safely escaped, sitting on the font's baseline", () => {
    const svg = buildSvg([text], { baselines: { sans: 0.9 } });
    assert.match(svg, /font-family="&quot;Archivo Variable&quot;, sans-serif"/);
    assert.match(svg, />Fish &amp; &lt;chips&gt;<\/tspan>/);
    // Top 200, plus half-leading (25 - 20) / 2, plus the baseline 0.9 x 20; the next line 25 lower.
    assert.match(svg, /<tspan x="10" y="220.5">/);
    assert.match(svg, /<tspan x="10" y="245.5">line two/);
  });

  it("turns rotated elements about their centre", () => {
    assert.match(buildSvg([rect("r", 0, 0, { angle: Math.PI / 2 })]), /<g transform="rotate\(90 50 25\)">/);
  });

  it("embeds pictures it has, and marks where the others go", () => {
    const withPicture = buildSvg([picture], { images: new Map([[picture.imageId, "data:image/png;base64,AAAA"]]) });
    assert.match(withPicture, /<image x="200" y="0" width="100" height="80" preserveAspectRatio="none" href="data:image\/png;base64,AAAA"\/>/);
    assert.match(buildSvg([picture]), /stroke-dasharray/);
  });

  it("embeds only the fonts the text uses", () => {
    const svg = buildSvg([text], { fontFaces: "@font-face { font-family: X; }" });
    assert.match(svg, /<defs><style>@font-face \{ font-family: X; \}<\/style><\/defs>/);
    assert.deepEqual([...fontsUsed([text, rect("r"), { ...text, id: "t2", font: "nope" }])].sort(), ["hand", "sans"]);
    assert.deepEqual([...fontsUsed([{ ...text, text: "" }])], [], "empty text needs no font");
  });
});

describe("board files", () => {
  it("round-trips a board, keeping only the pictures it uses", () => {
    const pictures = new Map([
      [picture.imageId, "data:image/png;base64,AAAA"],
      ["b".repeat(32), "data:image/png;base64,BBBB"],
    ]);
    const file = makeBoardFile({ title: "Plan", elements: [rect("r"), picture], pictures });
    assert.deepEqual(Object.keys(file.images), [picture.imageId]);

    const read = parseBoardFile(JSON.stringify(file));
    assert.equal(read.title, "Plan");
    assert.deepEqual(read.elements, [rect("r"), picture]);
    assert.equal(read.pictures.get(picture.imageId), "data:image/png;base64,AAAA");
  });

  it("explains what's wrong with a file it can't use", () => {
    const cases = [
      ["not json at all", /isn't a board file/],
      [JSON.stringify({ type: "excalidraw", elements: [] }), /isn't a board file/],
      [JSON.stringify({ type: "inkboard", version: 99, elements: [rect("r")] }), /newer version/],
      [JSON.stringify({ type: "inkboard", version: 1, elements: [{ nope: true }, 5] }), /empty/],
    ];
    for (const [text, message] of cases) {
      assert.throws(() => parseBoardFile(text), (error) => error instanceof BoardFileError && message.test(error.message));
    }
  });

  it("ignores pictures that aren't images", () => {
    const file = { type: "inkboard", version: 1, elements: [picture], images: { [picture.imageId]: "javascript:alert(1)" } };
    assert.equal(parseBoardFile(JSON.stringify(file)).pictures.size, 0);
  });

  it("places imported elements with new ids, centred where asked, keeping their layout", () => {
    const original = [rect("a", 0, 0), rect("b", 200, 100)];
    const placed = placeElements(original, { x: 1000, y: 1000 });
    assert.ok(placed.every((element, index) => element.id !== original[index].id));
    assert.equal(new Set(placed.map((element) => element.id)).size, 2);
    const bounds = getSceneBounds(placed);
    assert.ok(Math.abs(bounds.x + bounds.width / 2 - 1000) < 1e-9 && Math.abs(bounds.y + bounds.height / 2 - 1000) < 1e-9);
    assert.equal(placed[1].x1 - placed[0].x1, 200);
  });
});

describe("sending changes", () => {
  it("splits a big change into pieces under the size limit, in order", () => {
    const pending = new Map();
    for (let index = 0; index < 50; index += 1) pending.set(`e${index}`, rect(`e${index}`, index, 0, { note: "x".repeat(1000) }));
    pending.set("gone", null);
    const operations = toOperations(pending, 10_000);

    assert.ok(operations.length > 1);
    for (const op of operations) assert.ok(JSON.stringify(op).length < 12_000, "each piece stays near the limit");
    assert.deepEqual(operations.flatMap((op) => op.upsert.map((element) => element.id)), [...pending.keys()].slice(0, 50));
    assert.deepEqual(operations.at(-1).remove, ["gone"]);
  });

  it("sends a small change in one go", () => {
    const operations = toOperations(new Map([["a", rect("a")], ["b", null]]));
    assert.deepEqual(operations, [{ upsert: [rect("a")], remove: ["b"] }]);
  });
});
