import assert from "node:assert/strict";
import { describe, it } from "node:test";

// Text is measured with a canvas, which Node doesn't have: a stand-in that makes
// every character 10 units wide is enough for these tests.
globalThis.document ??= {
  createElement: () => ({ getContext: () => ({ font: "", measureText: (text) => ({ width: text.length * 10 }) }) }),
};

const { buildSvg, fontsUsed, SVG_PADDING } = await import("../src/features/board/svgExport.ts");
const boardFile = await import("../src/features/board/boardFile.ts");
const { BoardFileError, makeBoardFile, parseBoardFile, placeElements } = boardFile;
const { getSceneBounds } = await import("../src/features/board/elements.ts");
const { toOperations } = await import("../src/features/board/store.ts");

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
const pen = {
  id: "p",
  type: "pen",
  points: [
    [0, 0, 0.5],
    [20, 10, 0.5],
    [40, 0, 0.5],
    [60, 15, 0.5],
  ],
  pressure: false,
  stroke: "#1971c2",
  penSize: 8,
};
const text = {
  id: "t",
  type: "text",
  x1: 10,
  y1: 200,
  text: "Fish & <chips>\nline two",
  stroke: "#16213a",
  fontSize: 20,
  font: "sans",
};
const picture = { id: "i", type: "image", imageId: "a".repeat(32), x1: 200, y1: 0, x2: 300, y2: 80 };

describe("SVG export", () => {
  it("draws nothing for an empty board", () => {
    assert.equal(buildSvg([]), null);
  });

  it("frames the drawing with padding, on a white background", () => {
    const svg = buildSvg([rect("r", 10, 20)]);
    const bounds = getSceneBounds([rect("r", 10, 20)]);
    const viewBox = [
      bounds.x - SVG_PADDING,
      bounds.y - SVG_PADDING,
      bounds.width + SVG_PADDING * 2,
      bounds.height + SVG_PADDING * 2,
    ];
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
    assert.match(
      withPicture,
      /<image x="200" y="0" width="100" height="80" preserveAspectRatio="none" xlink:href="data:image\/png;base64,AAAA"\/>/,
    );
    assert.match(buildSvg([picture]), /stroke-dasharray/);
  });

  it("draws a connector's route, broken around its label, and the label", () => {
    const arrow = {
      id: "a",
      type: "arrow",
      seed: 3,
      x1: 0,
      y1: 0,
      x2: 200,
      y2: 100,
      stroke: "#1971c2",
      fill: null,
      strokeWidth: 2.5,
      sketchy: false,
      route: "elbow",
      text: "Yes & no",
      font: "code",
    };
    const svg = buildSvg([arrow]);
    const [, clip] = svg.match(
      /<clipPath id="(svg[a-z0-9]+-label-gap-0)"><path clip-rule="evenodd" d="M[^"]+ZM[^"]+Z"\/><\/clipPath>/,
    );
    assert.ok(svg.includes(`<g clip-path="url(#${clip})"><path `));
    assert.match(svg, /text-anchor="middle"[^>]*><tspan x="150"[^>]*>Yes &amp; no<\/tspan>/);
    assert.deepEqual([...fontsUsed([arrow])], ["code"]);
    assert.deepEqual([...fontsUsed([{ ...arrow, text: "" }])], [], "no label, no font");
  });

  it("embeds only the fonts the text uses", () => {
    const svg = buildSvg([text], { fontFaces: "@font-face { font-family: X; }" });
    assert.match(svg, /<defs><style>@font-face \{ font-family: X; \}<\/style><\/defs>/);
    assert.deepEqual([...fontsUsed([text, rect("r"), { ...text, id: "t2", font: "nope" }])].sort(), ["hand", "sans"]);
    assert.deepEqual([...fontsUsed([{ ...text, text: "" }])], [], "empty text needs no font");
  });

  it("leaves out characters XML can't hold, so the file always opens", () => {
    // A vertical tab, as Word puts in pasted text, a NUL, and half an emoji.
    const messy = { ...text, text: "one\u000Btwo\u0000 & \uD83D three\tfour" };
    const svg = buildSvg([messy]);
    assert.match(svg, />onetwo &amp; {2}three\tfour<\/tspan>/);
    // eslint-disable-next-line no-control-regex
    assert.doesNotMatch(svg, /[\u0000-\u0008\u000B\u000C\u000E-\u001F\uD800-\uDFFF￾￿]/);
    assert.match(buildSvg([{ ...text, text: "fine 😀" }]), /fine 😀<\/tspan>/, "whole emoji stay");
  });

  it("draws an unknown font name, even one that is a property of every object, in the default font", () => {
    for (const font of ["constructor", "toString", "__proto__"]) {
      const odd = { ...text, font };
      assert.match(buildSvg([odd]), /font-family="&quot;Caveat Variable&quot;, cursive"/, font);
      assert.deepEqual([...fontsUsed([odd])], ["hand"], font);
    }
  });

  it("gives notes their soft shadow, and ids no other export on the page shares", () => {
    const sticky = {
      id: "n",
      type: "sticky",
      x1: 0,
      y1: 0,
      x2: 200,
      y2: 200,
      text: "Hi",
      fill: "#ffec99",
      font: "hand",
    };
    const arrow = { ...rect("a"), type: "arrow", route: "straight", text: "go", font: "hand", x2: 100, y2: 0 };
    const first = buildSvg([sticky, arrow]);
    const second = buildSvg([sticky, arrow]);
    assert.match(first, /<filter id="[^"]+"[^>]*><feDropShadow dx="0" dy="3" stdDeviation="5" /);
    const idsOf = (svg) => [...svg.matchAll(/ id="([^"]+)"/g)].map((match) => match[1]);
    assert.equal(new Set(idsOf(first)).size, idsOf(first).length, "unique within one export");
    assert.equal(idsOf(first).length, 2, "a shadow and a clip");
    assert.ok(
      idsOf(first).every((id) => !idsOf(second).includes(id)),
      "and across exports",
    );
    const [, shadow] = first.match(/<rect [^>]*filter="url\(#([^)]+)\)"/);
    assert.ok(idsOf(first).includes(shadow), "the note uses its filter");
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
      [JSON.stringify({ type: "inkboard", version: 1, elements: [{ nope: true }, 5] }), /None of the elements/],
      [JSON.stringify({ type: "inkboard", version: 1, elements: [] }), /empty/],
    ];
    for (const [text, message] of cases) {
      assert.throws(
        () => parseBoardFile(text),
        (error) => error instanceof BoardFileError && message.test(error.message),
      );
    }
  });

  it("ignores pictures that aren't images", () => {
    const file = {
      type: "inkboard",
      version: 1,
      elements: [picture],
      images: { [picture.imageId]: "javascript:alert(1)" },
    };
    assert.equal(parseBoardFile(JSON.stringify(file)).pictures.size, 0);
  });

  it("places imported elements with new ids, centred where asked, keeping their layout", () => {
    const original = [rect("a", 0, 0), rect("b", 200, 100)];
    const placed = placeElements(original, { x: 1000, y: 1000 });
    assert.ok(placed.every((element, index) => element.id !== original[index].id));
    assert.equal(new Set(placed.map((element) => element.id)).size, 2);
    const bounds = getSceneBounds(placed);
    assert.ok(
      Math.abs(bounds.x + bounds.width / 2 - 1000) < 1e-9 && Math.abs(bounds.y + bounds.height / 2 - 1000) < 1e-9,
    );
    assert.equal(placed[1].x1 - placed[0].x1, 200);
  });
});

describe("sending changes", () => {
  it("splits a big change into pieces under the size limit, in order", () => {
    const pending = new Map();
    for (let index = 0; index < 50; index += 1)
      pending.set(`e${index}`, rect(`e${index}`, index, 0, { note: "x".repeat(1000) }));
    pending.set("gone", { removal: { id: "gone", version: 2, versionNonce: 1 } });
    const operations = toOperations(pending, 10_000);

    assert.ok(operations.length > 1);
    for (const op of operations) assert.ok(JSON.stringify(op).length < 12_000, "each piece stays near the limit");
    assert.deepEqual(
      operations.flatMap((op) => op.upsert.map((element) => element.id)),
      [...pending.keys()].slice(0, 50),
    );
    assert.deepEqual(operations.at(-1).remove, [{ id: "gone", version: 2, versionNonce: 1 }]);
  });

  it("sends a small change in one go", () => {
    const removal = { id: "b", version: 1, versionNonce: 0 };
    const operations = toOperations(
      new Map([
        ["a", rect("a")],
        ["b", { removal }],
      ]),
    );
    assert.deepEqual(operations, [{ upsert: [rect("a")], remove: [removal] }]);
  });
});

describe("importing a board file", () => {
  const { dataUrlToBlob, readBoardFile } = boardFile;
  const file = (elements) => JSON.stringify({ type: "inkboard", version: 1, elements });

  it("drops elements that would crash drawing, and counts them", () => {
    const read = parseBoardFile(
      file([
        rect("ok"),
        { id: "p", type: "pen" },
        { id: "t", type: "text", text: 123, x1: 0, y1: 0 },
        { id: "s", type: "sticky", x1: 0, y1: 0, x2: 1, y2: 1 },
      ]),
    );
    assert.deepEqual(
      read.elements.map((element) => element.id),
      ["ok"],
    );
    assert.equal(read.skipped, 3);
    assert.throws(() => parseBoardFile(file([{ id: "p", type: "pen" }])), /None of the elements/);
  });

  it("refuses a file with more elements than a board holds", () => {
    const many = Array.from({ length: 5001 }, (_, index) => rect(`r${index}`));
    assert.throws(
      () => parseBoardFile(file(many)),
      (error) => error instanceof BoardFileError && /more than/.test(error.message),
    );
  });

  it("refuses a file that is far too big before reading it", async () => {
    await assert.rejects(readBoardFile({ size: 200_000_000, text: () => assert.fail("read it") }), BoardFileError);
  });

  it("turns a data URL into a Blob without fetch", async () => {
    const png = dataUrlToBlob("data:image/png;base64,AQID");
    assert.equal(png.type, "image/png");
    assert.deepEqual([...new Uint8Array(await png.arrayBuffer())], [1, 2, 3]);
    const plain = dataUrlToBlob("data:image/svg+xml,%3Csvg%3E");
    assert.equal(await plain.text(), "<svg>");
    assert.throws(() => dataUrlToBlob("https://example.com/a.png"), BoardFileError);
  });
});

describe("sending changes in pieces: cost", () => {
  it("sends many small changes as one piece, and still splits long strokes", () => {
    const small = new Map(Array.from({ length: 3000 }, (_, index) => [`e${index}`, rect(`e${index}`, index)]));
    assert.equal(toOperations(small).length, 1);
    const stroke = (id) => ({
      ...pen,
      id,
      points: Array.from({ length: 12_000 }, (_, i) => [i * 1.123456789, i * 2.3456789, 0.5]),
    });
    const long = new Map([
      ["s1", stroke("s1")],
      ["s2", stroke("s2")],
      ["s3", stroke("s3")],
    ]);
    const pieces = toOperations(long);
    assert.ok(pieces.length > 1);
    for (const op of pieces) assert.ok(JSON.stringify(op).length < 1_500_000);
  });
});

describe("exporting a picture", () => {
  it("stays inside what a canvas can be, whatever the shape of the board", async () => {
    const { exportScale } = await import("../src/features/board/exportSize.ts");
    assert.equal(exportScale(500, 500), 2);
    for (const [width, height] of [
      [8000, 8000],
      [20_000, 900],
      [3000, 3000],
    ]) {
      const scale = exportScale(width, height);
      assert.ok(Math.ceil(width * scale) * Math.ceil(height * scale) <= 16_800_000, `${width} x ${height}`);
      assert.ok(Math.max(width, height) * scale <= 8001);
    }
  });
});
