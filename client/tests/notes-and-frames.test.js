import assert from "node:assert/strict";
import { describe, it } from "node:test";
import { inStackOrder } from "@inkboard/shared/board-order";
import {
  createElement,
  createNote,
  duplicate,
  elementAt,
  frameContents,
  inDrawOrder,
  nextFrameName,
  stackKey,
  translate,
  withContents,
} from "../src/features/board/elements.js";
import { layoutNote, MIN_NOTE_FONT_SIZE, wrapLines } from "../src/features/board/notes.js";

// Every character is half the font size wide, so tests can work out where lines break.
const measure = (text, fontSize) => text.length * fontSize * 0.5;
const byWidth = (perChar) => (text) => text.length * perChar;

const note = (text, size = 200) => ({
  ...createNote({ x: 0, y: 0 }, { noteFill: "#ffec99", font: "hand" }),
  text,
  x2: size - 100,
  y2: size - 100,
});
const frame = (id, x1, y1, x2, y2) => ({ id, type: "frame", x1, y1, x2, y2, name: id });
const box = (id, x1, y1, x2 = x1 + 10, y2 = y1 + 10) => ({
  id,
  type: "rectangle",
  x1,
  y1,
  x2,
  y2,
  stroke: "#000000",
  fill: "#ffffff",
  strokeWidth: 2,
  sketchy: false,
});
const ids = (elements) => elements.map((element) => element.id);

describe("sticky note text", () => {
  it("wraps between words, keeps line breaks, and breaks words too long for a line", () => {
    assert.deepEqual(wrapLines("one two three", 7, byWidth(1)), ["one two", "three"]);
    assert.deepEqual(wrapLines("a\n\nb", 10, byWidth(1)), ["a", "", "b"]);
    assert.deepEqual(wrapLines("abcdefghij", 4, byWidth(1)), ["abcd", "efgh", "ij"]);
    assert.deepEqual(wrapLines("", 10, byWidth(1)), [""]);
  });

  it("starts large on an empty or short note, and shrinks as the text grows", () => {
    const short = layoutNote(note("Hi"), measure);
    const long = layoutNote(note("A much longer thought that needs several lines to fit on the note"), measure);
    assert.ok(short.fontSize > long.fontSize, `${short.fontSize} > ${long.fontSize}`);
    assert.deepEqual(short.lines, ["Hi"]);
    for (const layout of [short, long]) {
      assert.ok(layout.lines.length * layout.lineHeight <= layout.height, "every line fits");
      assert.ok(layout.lines.every((line) => measure(line, layout.fontSize) <= layout.width));
    }
  });

  it("centres the text in the note", () => {
    const layout = layoutNote(note("Hi"), measure);
    assert.equal(layout.centerX, 0);
    const middle = layout.top + (layout.lines.length * layout.lineHeight) / 2;
    assert.equal(middle, 0);
  });

  it("grows its writing with the note", () => {
    assert.ok(layoutNote(note("Hi", 400), measure).fontSize > layoutNote(note("Hi", 200), measure).fontSize);
  });

  it("stops shrinking at the smallest size, however much there is to say", () => {
    const layout = layoutNote(note("word ".repeat(2000)), measure);
    assert.equal(layout.fontSize, MIN_NOTE_FONT_SIZE);
  });
});

describe("frames", () => {
  it("are drawn beneath everything else, each kind in stack order", () => {
    const elements = inStackOrder([
      box("a", 0, 0),
      frame("f1", 0, 0, 100, 100),
      box("b", 5, 5),
      frame("f2", 0, 0, 50, 50),
    ]);
    assert.deepEqual(ids(inDrawOrder(elements)), ["f1", "f2", "a", "b"]);
    const plain = [box("a", 0, 0)];
    assert.equal(inDrawOrder(plain), plain);
  });

  it("hold what lies wholly inside them, including frames inside them", () => {
    const outer = frame("outer", 0, 0, 500, 500);
    const inner = frame("inner", 100, 100, 300, 300);
    const elements = inStackOrder([
      outer,
      inner,
      box("inside-both", 150, 150),
      box("inside-outer", 400, 400),
      box("half-out", 490, 10, 520, 30),
      box("outside", 600, 600),
    ]);
    assert.deepEqual(ids(frameContents(elements, outer)), ["inner", "inside-both", "inside-outer"]);
    assert.deepEqual(ids(frameContents(elements, inner)), ["inside-both"]);
    assert.deepEqual(ids(withContents(elements, inner)), ["inner", "inside-both"]);
    assert.deepEqual(ids(withContents(elements, elements[2])), ["inside-both"], "other elements stand alone");
  });

  it("share nothing when they overlap: each element belongs to one of them", () => {
    // A copy dropped over the original, 16 units along: deleting one mustn't take the other's contents.
    const elements = inStackOrder([
      frame("original", 0, 0, 300, 300),
      box("a", 20, 20),
      frame("copy", 16, 16, 316, 316),
      box("b", 36, 36),
      box("c", 280, 280),
    ]);
    const inOriginal = ids(frameContents(elements, elements[0]));
    const inCopy = ids(frameContents(elements, elements[2]));
    assert.deepEqual([...inOriginal, ...inCopy].sort(), ["a", "b", "c"]);
    assert.ok(inCopy.includes("c"), "only the copy is around it");
  });

  it("never hold each other, even when they're the same size", () => {
    const elements = inStackOrder([frame("lower", 0, 0, 100, 100), frame("upper", 0, 0, 100, 100), box("x", 10, 10)]);
    assert.deepEqual(ids(frameContents(elements, elements[0])), ["x"]);
    assert.deepEqual(ids(frameContents(elements, elements[1])), ["lower", "x"], "the upper one holds the lower one");
  });

  it("move, copy and delete with what's in them", () => {
    const elements = inStackOrder([frame("f", 0, 0, 300, 300), box("in", 50, 50), box("out", 400, 400)]);
    const group = withContents(elements, elements[0]);
    const moved = group.map((element) => translate(element, 1000, 0));
    const after = elements.map((element) => moved.find((m) => m.id === element.id) ?? element);
    assert.deepEqual(ids(frameContents(after, moved[0])), ["in"], "still inside after the move");
    const copies = group.map(duplicate);
    assert.equal(new Set([...ids(copies), ...ids(elements)]).size, 5, "copies get their own ids");
  });

  it("are picked by their border, by what's in them, or by their inside when nothing else is there", () => {
    const outer = frame("outer", 0, 0, 500, 500);
    const inner = frame("inner", 100, 100, 300, 300);
    const elements = inStackOrder([outer, inner, box("shape", 150, 150, 200, 200)]);
    assert.equal(elementAt(elements, 175, 175, 1).id, "shape", "a shape on a frame");
    assert.equal(elementAt(elements, 250, 250, 1).id, "inner", "inside the innermost frame");
    assert.equal(elementAt(elements, 50, 50, 1).id, "outer");
    assert.equal(elementAt(elements, 500, 250, 2).id, "outer", "its border");
    assert.equal(elementAt(elements, 700, 700, 1), null);
  });

  it("only move in the stack among frames", () => {
    const elements = inStackOrder([frame("f1", 0, 0, 100, 100), box("a", 10, 10), frame("f2", 0, 0, 100, 100)]);
    const key = stackKey(elements, elements[0], "front");
    assert.ok(key > elements[2].index, "above the other frame");
    assert.equal(stackKey(elements, elements[2], "front"), null, "already the top frame, whatever is above it");
    assert.equal(stackKey(elements, elements[1], "back"), null, "a shape is already at the back of the shapes");
  });

  it("are named Frame 1, Frame 2, … without repeating a name in use", () => {
    assert.equal(nextFrameName([]), "Frame 1");
    assert.equal(nextFrameName([frame("Frame 2", 0, 0, 1, 1)]), "Frame 3");
    assert.equal(nextFrameName([{ ...frame("a", 0, 0, 1, 1), name: "Frame 2" }]), "Frame 3");
    assert.equal(nextFrameName([{ ...frame("a", 0, 0, 1, 1), name: "Ideas" }]), "Frame 2");
  });

  it("start empty-named from the frame tool", () => {
    const created = createElement("frame", { x: 3, y: 4 }, {});
    assert.deepEqual({ ...created, id: "x" }, { id: "x", type: "frame", x1: 3, y1: 4, x2: 3, y2: 4, name: "" });
  });
});
