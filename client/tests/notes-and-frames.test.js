import assert from "node:assert/strict";
import { describe, it } from "node:test";
import { inStackOrder } from "@inkboard/shared/board-order";
import { resolveConnectors } from "../src/features/board/connectors.ts";
import {
  createElement,
  createNote,
  duplicate,
  elementAt,
  frameContents,
  frameLabel,
  getBounds,
  inDrawOrder,
  nextFrameName,
  stackKey,
  translate,
  withContents,
} from "../src/features/board/elements.ts";
import { LINE_HEIGHT } from "../src/features/board/constants.ts";
import { layoutNote, MIN_NOTE_FONT_SIZE, NOTE_PADDING, wrapLines } from "../src/features/board/notes.ts";
import { loadCanvasFonts } from "../src/features/board/renderer.js";

// Text is measured with a canvas, which Node doesn't have: a stand-in makes every character `perCharacter` wide.
let perCharacter = 10;
let measurements = 0;
globalThis.document = {
  createElement: () => ({
    getContext: () => ({
      font: "",
      measureText: (text) => {
        measurements += 1;
        return { width: text.length * perCharacter };
      },
    }),
  }),
  fonts: { load: async () => {} },
};

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

  it("keeps spaces as the editor shows them", () => {
    assert.deepEqual(wrapLines("  indented", 20, byWidth(1)), ["  indented"], "at the start of a paragraph");
    assert.deepEqual(wrapLines("a  b", 20, byWidth(1)), ["a  b"], "between words");
    assert.deepEqual(wrapLines("abcd   efg", 4, byWidth(1)), ["abcd", "efg"], "hanging where a line breaks");
    assert.deepEqual(wrapLines(" ", 20, byWidth(1)), [" "]);
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

  it("starts writing that doesn't fit at the top of the note, so its beginning shows", () => {
    const layout = layoutNote(note("word ".repeat(2000)), measure);
    const pad = 200 * NOTE_PADDING;
    assert.ok(Math.abs(layout.top - (-100 + pad)) < 1e-9, "the top of the note, inside its padding");
    assert.ok(layout.shown < layout.lines.length, "not every line is shown");
    assert.ok(layout.shown * layout.lineHeight <= layout.height, "the lines shown fit");
    assert.ok((layout.shown + 1) * layout.lineHeight > layout.height, "as many as fit are shown");
    const short = layoutNote(note("Hi"), measure);
    assert.equal(short.shown, short.lines.length, "text that fits is all shown");
  });

  it("breaks a very long word without measuring it over and over", () => {
    const word = "x".repeat(20_000);
    let calls = 0;
    let measured = 0;
    const counting = (text) => {
      calls += 1;
      measured += text.length;
      return text.length;
    };
    const lines = wrapLines(word, 100, counting);
    assert.equal(lines.length, 200);
    assert.ok(lines.every((line) => line.length === 100));
    assert.equal(lines.join(""), word);
    assert.ok(calls < lines.length * 20, `${calls} measurements for ${lines.length} lines`);
    assert.ok(measured < word.length * 20, `${measured} characters measured for ${word.length}`);

    calls = 0;
    measured = 0;
    const layout = layoutNote({ ...note(word), font: "hand" }, (text, size) => {
      calls += 1;
      measured += text.length;
      return text.length * size * 0.5;
    });
    assert.equal(layout.fontSize, MIN_NOTE_FONT_SIZE);
    assert.equal(layout.lines.join(""), word);
    assert.ok(calls < 10_000, `${calls} measurements to lay out the note`);
    assert.ok(measured < word.length * 50, `${measured} characters measured to lay out the note`);
  });

  it("still finds the largest size that fits a long text, passing over the sizes it can't", () => {
    const text = "lorem ipsum dolor sit amet ".repeat(16);
    const layout = layoutNote(note(text), measure);
    assert.ok(layout.fontSize > MIN_NOTE_FONT_SIZE, "fits above the smallest size");
    assert.ok(layout.lines.length * layout.lineHeight <= layout.height);
    const larger = Math.floor(layout.fontSize / 0.9);
    const wrapped = wrapLines(text, layout.width, (line) => measure(line, larger));
    assert.ok(
      wrapped.length * larger * LINE_HEIGHT > layout.height || larger === layout.fontSize,
      "the next size up didn't",
    );
  });

  it("breaks between whole characters, never inside an emoji or a pair", () => {
    const family = "👨‍👩‍👧"; // seven code units, one character
    const grapheme = (text) => [...new Intl.Segmenter().segment(text)].length;
    const lines = wrapLines(family.repeat(5), 20, (text) => grapheme(text) * 10);
    assert.deepEqual(lines, [family.repeat(2), family.repeat(2), family]);
    const faces = wrapLines("😀".repeat(5), 20, (text) => [...text].length * 10);
    assert.deepEqual(faces, ["😀😀", "😀😀", "😀"]);
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

  it("are drawn after the frames around them, so a bigger frame never covers one inside it", () => {
    // The inner frame is lower in the stack than the outer one it sits in; frames not inside another come first.
    const elements = inStackOrder([
      frame("inner", 10, 10, 50, 50),
      frame("outer", 0, 0, 100, 100),
      frame("beside", 200, 0, 300, 100),
      box("a", 20, 20),
    ]);
    assert.deepEqual(ids(inDrawOrder(elements)), ["outer", "beside", "inner", "a"]);
    assert.deepEqual(
      ids(inDrawOrder(inStackOrder([frame("f1", 0, 0, 100, 100), frame("f2", 0, 0, 100, 100)]))),
      ["f1", "f2"],
      "equal frames keep their stack order",
    );
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

describe("text measured before the web fonts load", () => {
  it("is measured again once they have, wherever it was measured", async () => {
    const text = { id: "t", type: "text", x1: 0, y1: 0, text: "hello", stroke: "#000", fontSize: 20, font: "hand" };
    const turned = { ...text, id: "r", angle: 1 };
    const named = { ...frame("f", 0, 0, 500, 100), name: "hello" };
    const connector = { ...box("c", 0, 0), type: "arrow", startId: "t", x1: 0, y1: 0, x2: 400, y2: 0 };
    const board = [text, connector];

    // The fallback font's letters are narrower than the web font's.
    assert.equal(getBounds(text).width, 50);
    const turnedWidth = getBounds(turned).width;
    assert.equal(frameLabel(named).width, 50);
    const startedAt = resolveConnectors(board)[1].x1;

    perCharacter = 20;
    assert.equal(getBounds(text).width, 50, "kept until the fonts load");
    await loadCanvasFonts();
    assert.equal(getBounds(text).width, 100);
    assert.ok(getBounds(turned).width > turnedWidth, "turned bounds too");
    assert.equal(frameLabel(named).width, 100);
    assert.ok(resolveConnectors(board)[1].x1 > startedAt, "connectors attached to the text start further out");
    perCharacter = 10;
  });
});

describe("frame names", () => {
  const named = (name, width) => ({ ...frame("f", 0, 0, width, 100), name });

  it("are cut short to the frame's width, with an ellipsis", () => {
    assert.equal(frameLabel(named("abcdefghij", 55)).text, "abcd…");
    assert.equal(frameLabel(named("abcdefghij", 200)).text, "abcdefghij");
    assert.equal(frameLabel(named("abcdefghij", 5)).text, "a…", "keeps at least a character");
    assert.equal(frameLabel(named("😀".repeat(10), 75)).text, "😀😀😀…", "never half an emoji");
  });

  it("are cut short in a few measurements, not one per letter", () => {
    measurements = 0;
    const label = frameLabel(named("x".repeat(5000), 300));
    assert.equal(label.text, `${"x".repeat(29)}…`);
    assert.ok(measurements < 40, `${measurements} measurements`);
  });
});
