import assert from "node:assert/strict";
import { describe, it } from "node:test";
import {
  cleanBases,
  diffText,
  followText,
  mapIndex,
  mergeText,
  spliceOf,
  textBefore,
  withoutBase,
} from "../src/text-merge.ts";
import type { Hunk } from "../src/text-merge.ts";
import type { Element } from "../src/types.ts";

// A small seeded generator, so a failure can be reproduced from its seed.
function random(seed: number) {
  let state = seed >>> 0;
  return () => {
    state = (state * 1664525 + 1013904223) >>> 0;
    return state / 2 ** 32;
  };
}

const applied = (text: string, hunks: Hunk[]) => {
  let out = "";
  let at = 0;
  for (const [start, end, insert] of hunks) {
    out += text.slice(at, start) + insert;
    at = end;
  }
  return out + text.slice(at);
};

describe("a text's changes", () => {
  it("turn one text into the other, in order and apart, for any two texts", () => {
    const next = random(1);
    const text = () => Array.from({ length: Math.floor(next() * 30) }, () => "ab c"[Math.floor(next() * 4)]).join("");
    for (let round = 0; round < 2000; round += 1) {
      const [from, to] = [text(), text()];
      const hunks = diffText(from, to)!;
      assert.equal(applied(from, hunks), to, JSON.stringify([from, to]));
      hunks.forEach(([start], index) => index > 0 && assert.ok(start > hunks[index - 1]![1], "hunks don't touch"));
    }
  });

  it("are as few letters as can be, so typing in two places is two changes", () => {
    assert.deepEqual(diffText("hello world", "hello brave world"), [[6, 6, "brave "]]);
    assert.deepEqual(diffText("one two three", "One two three!"), [
      [0, 1, "O"],
      [13, 13, "!"],
    ]);
  });

  it("aren't worked out when that would take too long", () => {
    const long = "x".repeat(20_000);
    assert.equal(diffText(`${long}${"a".repeat(20_000)}`, `${"b".repeat(20_000)}${long}`), null);
    // Far apart in a long text is still quick.
    assert.equal(diffText(`a${long}b`, `A${long}B`)!.length, 2);
  });
});

describe("two people's typing merged", () => {
  it("keeps what both typed in different places", () => {
    assert.equal(mergeText("hello world", "Hey, hello world", "hello brave world!"), "Hey, hello brave world!");
  });

  it("keeps both at the same place, what got to the board first ahead", () => {
    assert.equal(mergeText("note: ", "note: milk", "note: eggs"), "note: milkeggs");
  });

  it("deletes what either deleted, overlapping or not, and keeps what the other typed inside it", () => {
    assert.equal(mergeText("abcdefgh", "abgh", "abcdh"), "abh");
    assert.equal(mergeText("the quick fox", "the fox", "the quick red fox"), "the red fox");
  });

  it("keeps a change made by one side only, and one made the same by both once", () => {
    assert.equal(mergeText("abc", "abc", "abXc"), "abXc");
    assert.equal(mergeText("abc", "aXbc", "abc"), "aXbc");
    assert.equal(mergeText("abc", "abXc", "abXc"), "abXc");
  });

  it("gives up past the longest the text may be, or when the diff would take too long", () => {
    assert.equal(mergeText("", "abc", "def", 5), null);
    assert.equal(mergeText("", "abc", "def", 6), "abcdef");
  });
});

describe("a caret", () => {
  it("keeps its place among the letters around it", () => {
    const hunks = diffText("hello world", "Hey, hello there world")!;
    assert.equal(mapIndex(hunks, 1), 6, "after what was typed before it");
    assert.equal(mapIndex(hunks, 5), 10, "between words, before what was typed after it");
    assert.equal(mapIndex(hunks, 11), 22, "at the end");
  });

  it("stays before text typed right where it is, and goes after a stretch replaced around it", () => {
    assert.equal(mapIndex([[2, 2, "XY"]], 2), 2);
    assert.equal(mapIndex([[1, 4, "Z"]], 3), 2);
  });

  it("follows someone else's typing into the text being edited", () => {
    // Typing "brave " at 6 with the caret after it, while someone else adds "Hey, " at the start.
    const typing = { value: "hello brave world", base: "hello world", start: 12, end: 12 };
    assert.deepEqual(followText(typing, "Hey, hello world"), {
      value: "Hey, hello brave world",
      base: "Hey, hello world",
      start: 17,
      end: 17,
    });
    assert.equal(followText(typing, "hello world"), typing, "nothing changed on the board");
  });
});

describe("what a text was", () => {
  it("is told against what it is in a few letters, and read back exactly", () => {
    const next = random(2);
    const text = () => Array.from({ length: Math.floor(next() * 20) }, () => "xy"[Math.floor(next() * 2)]).join("");
    for (let round = 0; round < 500; round += 1) {
      const [before, now] = [text(), text()];
      assert.equal(textBefore(now, spliceOf(before, now)), before);
    }
    assert.deepEqual(spliceOf("hello world", "hello brave world"), [6, 5, ""]);
  });

  it("is only taken from a change where it fits the text it has", () => {
    const note = { id: "n", type: "sticky", text: "hello" } as unknown as Element;
    assert.deepEqual(cleanBases({ text: [2, 1, "x"], name: [0, 0, ""], nope: 1 }, note), { text: [2, 1, "x"] });
    for (const bad of [[3, 3, ""], [-1, 0, ""], [0, 0, 5], [0.5, 0, ""], "text", [0, 0]]) {
      assert.equal(cleanBases({ text: bad }, note), undefined, JSON.stringify(bad));
    }
    assert.equal(cleanBases({ text: [0, 0, "x".repeat(20_001)] }, note), undefined, "longer than a text may be");
    assert.equal(cleanBases(null, note), undefined);
    assert.deepEqual(withoutBase({ ...note, base: { text: [0, 0, ""] } }), note);
  });
});
