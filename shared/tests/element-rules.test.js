import assert from "node:assert/strict";
import { describe, it } from "node:test";

// A browser without Intl.Segmenter (Firefox before 125) must still load the rules, which the editor
// imports: the segmenter is only made when text is first cut, and there's a fallback without one.
const segmenter = Intl.Segmenter;
Intl.Segmenter = undefined;
const { cutText } = await import("../src/element-rules.js");

describe("cutting text without Intl.Segmenter", () => {
  it("loads, and cuts between code points, never inside a surrogate pair", () => {
    try {
      const smile = "\u{1F600}"; // a surrogate pair
      assert.equal(cutText("abcdef", 3), "abc");
      assert.equal(cutText(`ab${smile}`, 3), "ab");
      assert.equal(cutText(`ab${smile}c`, 4), `ab${smile}`);
    } finally {
      Intl.Segmenter = segmenter;
    }
  });
});
