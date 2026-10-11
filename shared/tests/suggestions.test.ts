import assert from "node:assert/strict";
import { describe, it } from "node:test";
import { changedGroups, isOutdated, stampsOf, suggestionId, withChange } from "../src/suggestions.ts";
import type { ChangeSuggestion, RemoveSuggestion } from "../src/suggestions.ts";
import type { Element, ShapeElement } from "../src/types.ts";

const box = (fields: Partial<ShapeElement> = {}): ShapeElement => ({
  id: "box",
  type: "rectangle",
  seed: 1,
  x1: 0,
  y1: 0,
  x2: 100,
  y2: 60,
  stroke: "#16213a",
  fill: null,
  strokeWidth: 2,
  sketchy: true,
  version: 3,
  versionNonce: 7,
  ...fields,
});

const author = { userId: "g_someone", name: "Sam", guest: true };

describe("suggestion ids", () => {
  it("know an addition by its element and anything else by its author and element, and never mix the two", () => {
    assert.equal(suggestionId("add", "u1", "box"), "add:box");
    assert.equal(suggestionId("change", "u1", "box"), "on:u1:box");
    assert.equal(suggestionId("remove", "u1", "box"), suggestionId("change", "u1", "box"));
    assert.notEqual(suggestionId("add", "u1", "on:u1:box"), suggestionId("change", "u1", "box"));
  });
});

describe("changedGroups", () => {
  it("lists only the property groups that differ, comparing lists by what's in them", () => {
    assert.deepEqual(changedGroups(box(), box()), []);
    assert.deepEqual(changedGroups(box(), box({ x1: 5, x2: 105 })), ["shape"]);
    assert.deepEqual(changedGroups(box(), box({ stroke: "#e03131", fill: "#ffd43b" })), ["stroke", "fill"]);
    // Pen strokes left partial: only their points matter here.
    const pen = (points: number[][]) => ({ id: "p", type: "pen", points }) as unknown as Element;
    assert.deepEqual(changedGroups(pen([[0, 0, 0.5]]), pen([[0, 0, 0.5]])), []);
    assert.deepEqual(changedGroups(pen([[0, 0, 0.5]]), pen([[0, 1, 0.5]])), ["shape"]);
  });

  it("ignores stamps, which aren't a property", () => {
    assert.deepEqual(changedGroups(box(), box({ version: 9, versionNonce: 1 })), []);
  });
});

describe("isOutdated", () => {
  it("tells whether the element was edited, in the groups a suggestion is about, since it was made", () => {
    const change: ChangeSuggestion = {
      id: "on:g_someone:box",
      kind: "change",
      target: "box",
      element: box({ x1: 50, x2: 150 }),
      groups: ["shape"],
      base: stampsOf(box(), ["shape"]),
      author,
      createdAt: 0,
      updatedAt: 0,
    };
    assert.equal(isOutdated(box(), change), false);
    // Recolored since, which leaves the shape's stamp as it was.
    assert.equal(isOutdated(box({ version: 4, versionNonce: 1, stamps: { shape: [3, 7] } }), change), false);
    // Moved since.
    assert.equal(isOutdated(box({ version: 4, versionNonce: 1 }), change), true);

    const removal: RemoveSuggestion = { ...change, kind: "remove", base: stampsOf(box()) };
    assert.equal(isOutdated(box({ version: 4, versionNonce: 1, stamps: { shape: [3, 7] } }), removal), true);
  });
});

describe("withChange", () => {
  it("takes only the suggested groups, keeping what else changed on the board meanwhile", () => {
    const suggested = { element: box({ x1: 50, x2: 150, stroke: "#000000" }), groups: ["shape" as const] };
    const recolored = box({ fill: "#ffd43b" });
    const accepted = withChange(recolored, suggested) as ShapeElement;
    assert.equal(accepted.x1, 50);
    assert.equal(accepted.x2, 150);
    assert.equal(accepted.fill, "#ffd43b");
    assert.equal(accepted.stroke, "#16213a", "the stroke wasn't one of the suggested groups");
  });
});
