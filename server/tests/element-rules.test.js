import assert from "node:assert/strict";
import { after, before, describe, it } from "node:test";
import { cleanElement, COORDINATE_LIMIT, MAX_TEXT_LENGTH } from "../src/realtime/element-rules.js";
import { eventually, rect, startServer, upsert } from "./helpers.js";

// What the client creates (see client/src/features/board/elements.js).
const pen = (overrides = {}) => ({
  id: "p",
  type: "pen",
  points: [
    [0, 0, 0.5],
    [10, 5, 0.6],
  ],
  pressure: false,
  stroke: "#16213a",
  penSize: 8,
  ...overrides,
});
const text = (overrides = {}) => ({ id: "t", type: "text", x1: 5, y1: 5, text: "Hi", stroke: "#e03131", fontSize: 32, font: "hand", ...overrides });
const picture = (overrides = {}) => ({ id: "i", type: "image", imageId: "a".repeat(32), x1: 0, y1: 0, x2: 200, y2: 100, ...overrides });
const line = (overrides = {}) => ({ ...rect("l"), type: "line", ...overrides });

describe("element rules", () => {
  it("keeps every kind of element the app makes exactly as it is", () => {
    for (const element of [rect("r"), { ...rect("e"), type: "ellipse", fill: "#b2f2bb" }, line(), { ...line(), type: "arrow" }, pen(), text(), picture()]) {
      assert.deepEqual(cleanElement(element), element);
    }
    const turned = { ...rect("r"), angle: 1.2 };
    assert.deepEqual(cleanElement(turned), turned);
  });

  it("refuses elements whose shape or content is broken", () => {
    const broken = [
      null,
      [],
      "rectangle",
      { ...rect("r"), id: "" },
      { ...rect("r"), id: "x".repeat(65) },
      { ...rect("r"), type: "spaceship" },
      { ...rect("r"), x2: Number.NaN },
      { ...rect("r"), y1: "12" },
      { ...rect("r"), x1: COORDINATE_LIMIT * 2 },
      pen({ points: [] }),
      pen({ points: "lots" }),
      pen({ points: [["a", "b"]] }),
      text({ text: 42 }),
      text({ text: "x".repeat(MAX_TEXT_LENGTH + 1) }),
      text({ x1: undefined }),
      picture({ imageId: "../../etc/passwd" }),
      picture({ x2: Infinity }),
    ];
    for (const element of broken) assert.equal(cleanElement(element), null, JSON.stringify(element));
  });

  it("keeps a place in the stack, and drops one that isn't a stacking key", () => {
    assert.equal(cleanElement({ ...rect("r"), index: "a0" }).index, "a0");
    for (const bad of ["", "a", "a0 ", "!x", 7, "a".repeat(200)]) {
      assert.equal("index" in cleanElement({ ...rect("r"), index: bad }), false, JSON.stringify(bad));
    }
  });

  it("keeps the stamps of a shape's property groups, with the newest as its version", () => {
    const cleaned = cleanElement({ ...rect("r"), version: 2, versionNonce: 1, stamps: { stroke: [9, 4], fill: [1, 1], made: [1, 1], sketchy: "x" } });
    assert.equal(cleaned.version, 9, "a group newer than the version it came with");
    assert.equal(cleaned.versionNonce, 4);
    assert.deepEqual(cleaned.stamps, { shape: [2, 1], fill: [1, 1], strokeWidth: [2, 1], sketchy: [2, 1], index: [2, 1] });
    assert.equal("stamps" in cleanElement({ ...rect("r"), stamps: { stroke: [9, 4] } }), false, "no version, no stamps");
  });

  it("keeps which edit an element is, and drops a version that isn't one", () => {
    assert.deepEqual(cleanElement({ ...rect("r"), version: 7, versionNonce: 12345 }), { ...rect("r"), version: 7, versionNonce: 12345 });
    for (const bad of [{ version: -1 }, { version: 1.5 }, { version: "3" }, { version: 2 ** 53 - 1 }, { versionNonce: 2 ** 31 }, { versionNonce: -2 }]) {
      const cleaned = cleanElement({ ...rect("r"), ...bad });
      assert.ok(!("version" in bad) || !("version" in cleaned), JSON.stringify(bad));
      assert.ok(!("versionNonce" in bad) || !("versionNonce" in cleaned), JSON.stringify(bad));
    }
  });

  it("drops fields the app doesn't use", () => {
    // Parsed, as it would arrive: "__proto__" becomes an ordinary field here.
    const sneaky = JSON.parse(JSON.stringify({ ...rect("r"), onclick: "alert(1)", nested: { a: 1 } }).replace("{", '{"__proto__":{"polluted":true},'));
    assert.ok(Object.hasOwn(sneaky, "__proto__"));
    assert.deepEqual(cleanElement(sneaky), rect("r"));
    assert.equal({}.polluted, undefined);
    assert.deepEqual(cleanElement({ ...line(), angle: 2 }), line(), "lines and arrows don't turn");
  });

  it("repairs how an element looks instead of refusing it", () => {
    assert.deepEqual(cleanElement({ ...rect("r"), stroke: "red; background: url(x)", fill: 5, strokeWidth: 1e9, sketchy: "no", seed: -4 }), {
      ...rect("r"),
      stroke: "#16213a",
      fill: null,
      strokeWidth: 100,
      sketchy: true,
      seed: 1,
    });
    assert.deepEqual(cleanElement(text({ fontSize: 2, font: "comic" })), text({ fontSize: 8, font: "hand" }));
    assert.equal(cleanElement(line({ fill: "#ffffff" })).fill, null, "only rectangles and ellipses are filled");
  });

  it("keeps a stroke's good points and evens out odd pressures", () => {
    const cleaned = cleanElement(pen({ points: [[0, 0, 7], "x", [Number.NaN, 1], [3, 4]], pressure: "yes", penSize: -1 }));
    assert.deepEqual(cleaned.points, [
      [0, 0, 1],
      [3, 4, 0.5],
    ]);
    assert.equal(cleaned.pressure, false);
    assert.equal(cleaned.penSize, 0.5);
  });
});

describe("element rules on a live board", () => {
  let app;
  before(async () => {
    app = await startServer();
  });
  after(() => app.stop());

  it("stores and shares only the cleaned element, and refuses a change with nothing valid in it", async () => {
    const owner = await app.signUp("Owner");
    const boardId = await app.createBoard(owner);
    const editor = await app.connect(owner);
    const watcher = await app.connect(owner);
    await editor.join(boardId);
    await watcher.join(boardId);

    const sent = { ...rect("r"), index: "a0", version: 1, versionNonce: 5 };
    assert.equal((await editor.op(boardId, upsert({ ...sent, extra: "x".repeat(1000) }))).ok, true);
    await eventually(() => watcher.of("board:op").length > 0, { message: "the change reaching the other screen" });
    assert.deepEqual(watcher.of("board:op")[0].op.upsert, [sent]);

    assert.equal((await editor.op(boardId, upsert({ ...rect("bad"), x1: Number.NaN }))).ok, false);
    const reopened = await (await app.connect(owner)).join(boardId);
    assert.deepEqual(reopened.board.elements, [sent]);
  });
});
