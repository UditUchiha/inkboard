import assert from "node:assert/strict";
import { after, before, describe, it } from "node:test";
import {
  cleanElement,
  COORDINATE_LIMIT,
  cutText,
  MAX_FRAME_NAME_LENGTH,
  MAX_STROKE_POINTS,
  MAX_TEXT_LENGTH,
  withDefaults,
} from "@inkboard/shared/element-rules";
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
const text = (overrides = {}) => ({
  id: "t",
  type: "text",
  x1: 5,
  y1: 5,
  text: "Hi",
  stroke: "#e03131",
  fontSize: 32,
  font: "hand",
  ...overrides,
});
const picture = (overrides = {}) => ({
  id: "i",
  type: "image",
  imageId: "a".repeat(32),
  x1: 0,
  y1: 0,
  x2: 200,
  y2: 100,
  ...overrides,
});
// A line or arrow has a label, a route and a label font from the start, and an arrow a start head.
const line = (overrides = {}) => ({
  ...rect("l"),
  type: "line",
  text: "",
  route: "straight",
  font: "hand",
  ...overrides,
});
const arrow = (overrides = {}) => line({ type: "arrow", startHead: false, ...overrides });
const note = (overrides = {}) => ({
  id: "n",
  type: "sticky",
  x1: 0,
  y1: 0,
  x2: 200,
  y2: 200,
  text: "Ship it",
  fill: "#ffec99",
  font: "hand",
  ...overrides,
});
const frame = (overrides = {}) => ({
  id: "f",
  type: "frame",
  x1: 0,
  y1: 0,
  x2: 800,
  y2: 600,
  name: "Frame 1",
  ...overrides,
});

describe("element rules", () => {
  it("keeps every kind of element the app makes exactly as it is", () => {
    for (const element of [
      rect("r"),
      { ...rect("e"), type: "ellipse", fill: "#b2f2bb" },
      line(),
      arrow(),
      pen(),
      text(),
      picture(),
      note(),
      note({ text: "" }),
      frame(),
      frame({ name: "" }),
    ]) {
      assert.deepEqual(cleanElement(element), element);
    }
    for (const turned of [{ ...rect("r"), angle: 1.2 }, note({ angle: -0.3 })]) {
      assert.deepEqual(cleanElement(turned), turned);
    }
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
      picture({ imageId: ["a".repeat(32)] }),
      picture({ x2: Infinity }),
      note({ text: undefined }),
      note({ text: "x".repeat(MAX_TEXT_LENGTH + 1) }),
      note({ y2: "200" }),
      frame({ x2: undefined }),
    ];
    for (const element of broken) assert.equal(cleanElement(element), null, JSON.stringify(element));
  });

  it("keeps the shapes a connector is attached to, and drops attachments that can't be", () => {
    const attached = arrow({ startId: "a", endId: "b" });
    assert.deepEqual(cleanElement(attached), attached);
    const cleaned = cleanElement({ ...line(), startId: 42, endId: "l" });
    assert.equal("startId" in cleaned, false, "not an id");
    assert.equal("endId" in cleaned, false, "itself");
    assert.equal("startId" in cleanElement({ ...line(), startId: "x".repeat(65) }), false);
    assert.equal("startId" in cleanElement({ ...rect("r"), startId: "a" }), false, "only lines and arrows connect");
  });

  it("doesn't attach both ends of a connector to the same element", () => {
    const cleaned = cleanElement({ ...line(), startId: "a", startAnchor: "top", endId: "a", endAnchor: "bottom" });
    assert.deepEqual([cleaned.startId, cleaned.startAnchor], ["a", "top"]);
    assert.equal("endId" in cleaned, false);
    assert.equal("endAnchor" in cleaned, false);
  });

  it("refuses a stroke with an absurd number of points", () => {
    const points = (count) => Array.from({ length: count }, (_, n) => [n, n, 0.5]);
    assert.equal(cleanElement(pen({ points: points(MAX_STROKE_POINTS + 1) })), null);
    assert.equal(cleanElement(pen({ points: points(MAX_STROKE_POINTS) })).points.length, MAX_STROKE_POINTS);
  });

  it("cuts long text between whole characters, never inside an emoji", () => {
    const family = "\u{1F468}‍\u{1F469}‍\u{1F467}"; // one emoji, 8 UTF-16 units
    const smile = "\u{1F600}"; // a surrogate pair
    assert.equal(cutText("abc", 5), "abc");
    assert.equal(cutText("abcdef", 3), "abc");
    assert.equal(cutText(`ab${family}`, 5), "ab", "a joined sequence is kept whole or left out");
    assert.equal(cutText(`ab${family}`, 10), `ab${family}`);
    const name = cleanElement(frame({ name: `${"a".repeat(MAX_FRAME_NAME_LENGTH - 1)}${smile}` })).name;
    assert.equal(name, "a".repeat(MAX_FRAME_NAME_LENGTH - 1));
    const label = cleanElement({ ...line(), text: `${"a".repeat(MAX_TEXT_LENGTH - 1)}${family}` }).text;
    assert.equal(label, "a".repeat(MAX_TEXT_LENGTH - 1));
  });

  it("keeps a connector's pinned sides, route, arrowheads and label, and drops what isn't one", () => {
    const full = {
      ...line(),
      type: "arrow",
      startId: "a",
      startAnchor: "right",
      endId: "b",
      endAnchor: "top",
      route: "elbow",
      startHead: true,
      text: "Yes",
      font: "sans",
    };
    assert.deepEqual(cleanElement(full), full);
    const odd = cleanElement({
      ...line(),
      startAnchor: "right", // pinned to nothing
      endId: "b",
      endAnchor: "middle",
      route: "wiggly",
      startHead: true, // a line has no heads
      text: 7,
      font: "comic",
    });
    for (const key of ["startAnchor", "endAnchor", "startHead"]) {
      assert.equal(key in odd, false, key);
    }
    assert.deepEqual([odd.route, odd.text, odd.font], ["straight", "", "hand"], "what isn't one is the default");
    assert.equal(cleanElement({ ...line(), text: "x".repeat(MAX_TEXT_LENGTH + 5) }).text.length, MAX_TEXT_LENGTH);
    assert.equal(
      "route" in cleanElement({ ...rect("r"), route: "curved" }),
      false,
      "only lines and arrows have routes",
    );
  });

  it("fills in what a line or arrow saved before it had a label, route or arrowheads lacks, as never set", () => {
    const { text: _text, route: _route, font: _font, ...saved } = line();
    const old = { ...saved, type: "arrow", version: 3, versionNonce: 7 };
    const filled = cleanElement(old);
    assert.deepEqual([filled.text, filled.route, filled.font, filled.startHead], ["", "straight", "hand", false]);
    assert.equal(filled.version, 3, "the element's own stamp is unchanged");
    for (const group of ["text", "route", "font", "startHead"]) assert.deepEqual(filled.stamps[group], [0, 0], group);
    assert.equal(withDefaults(filled), filled, "nothing is missing any more");
    const plain = rect("r");
    assert.equal(withDefaults(plain), plain, "other kinds are left as they are");
  });

  it("keeps a place in the stack, and drops one that isn't a stacking key", () => {
    assert.equal(cleanElement({ ...rect("r"), index: "a0" }).index, "a0");
    for (const bad of ["", "a", "a0 ", "!x", 7, "a".repeat(200)]) {
      assert.equal("index" in cleanElement({ ...rect("r"), index: bad }), false, JSON.stringify(bad));
    }
  });

  it("keeps the stamps of a shape's property groups, with the newest as its version", () => {
    const cleaned = cleanElement({
      ...rect("r"),
      version: 2,
      versionNonce: 1,
      stamps: { stroke: [9, 4], fill: [1, 1], made: [1, 1], sketchy: "x" },
    });
    assert.equal(cleaned.version, 9, "a group newer than the version it came with");
    assert.equal(cleaned.versionNonce, 4);
    assert.deepEqual(cleaned.stamps, {
      shape: [2, 1],
      fill: [1, 1],
      strokeWidth: [2, 1],
      sketchy: [2, 1],
      index: [2, 1],
    });
    assert.equal(
      "stamps" in cleanElement({ ...rect("r"), stamps: { stroke: [9, 4] } }),
      false,
      "no version, no stamps",
    );
  });

  it("keeps which edit an element is, and drops a version that isn't one", () => {
    assert.deepEqual(cleanElement({ ...rect("r"), version: 7, versionNonce: 12345 }), {
      ...rect("r"),
      version: 7,
      versionNonce: 12345,
    });
    for (const bad of [
      { version: -1 },
      { version: 1.5 },
      { version: "3" },
      { version: 2 ** 53 - 1 },
      { versionNonce: 2 ** 31 },
      { versionNonce: -2 },
    ]) {
      const cleaned = cleanElement({ ...rect("r"), ...bad });
      assert.ok(!("version" in bad) || !("version" in cleaned), JSON.stringify(bad));
      assert.ok(!("versionNonce" in bad) || !("versionNonce" in cleaned), JSON.stringify(bad));
    }
  });

  it("drops fields the app doesn't use", () => {
    // Parsed, as it would arrive: "__proto__" becomes an ordinary field here.
    const sneaky = JSON.parse(
      JSON.stringify({ ...rect("r"), onclick: "alert(1)", nested: { a: 1 } }).replace(
        "{",
        '{"__proto__":{"polluted":true},',
      ),
    );
    assert.ok(Object.hasOwn(sneaky, "__proto__"));
    assert.deepEqual(cleanElement(sneaky), rect("r"));
    assert.equal({}.polluted, undefined);
    assert.deepEqual(cleanElement({ ...line(), angle: 2 }), line(), "lines and arrows don't turn");
    assert.deepEqual(cleanElement(frame({ angle: 2, stroke: "#000000", text: "hi" })), frame(), "nor do frames");
  });

  it("repairs how an element looks instead of refusing it", () => {
    assert.deepEqual(
      cleanElement({
        ...rect("r"),
        stroke: "red; background: url(x)",
        fill: 5,
        strokeWidth: 1e9,
        sketchy: "no",
        seed: -4,
      }),
      {
        ...rect("r"),
        stroke: "#16213a",
        fill: null,
        strokeWidth: 100,
        sketchy: true,
        seed: 1,
      },
    );
    assert.deepEqual(cleanElement(text({ fontSize: 2, font: "comic" })), text({ fontSize: 8, font: "hand" }));
    assert.equal(cleanElement(line({ fill: "#ffffff" })).fill, null, "only rectangles and ellipses are filled");
    assert.deepEqual(cleanElement(note({ fill: "yellow", font: "comic" })), note({ fill: "#ffec99", font: "hand" }));
    assert.equal(cleanElement(frame({ name: 42 })).name, "", "a name that isn't text");
    assert.equal(cleanElement(frame({ name: "x".repeat(500) })).name.length, MAX_FRAME_NAME_LENGTH);
  });

  it("keeps a stroke's good points and evens out odd pressures", () => {
    const cleaned = cleanElement(
      pen({ points: [[0, 0, 7], "x", [Number.NaN, 1], [3, 4]], pressure: "yes", penSize: -1 }),
    );
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
