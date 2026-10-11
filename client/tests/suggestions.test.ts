import assert from "node:assert/strict";
import { describe, it } from "node:test";
import { stampsOf } from "@inkboard/shared/suggestions";
import type { Element, ShapeElement } from "@inkboard/shared/types";
import { createBoardStore } from "../src/features/board/store.ts";
import {
  acceptance,
  createSuggestionStore,
  GROUP_GAP_MS,
  groupSuggestions,
  suggestionMarks,
  summarize,
} from "../src/features/board/suggestions.ts";
import type { Suggestion } from "../src/features/board/suggestions.ts";

const rect = (id: string, x = 0, fields: Partial<ShapeElement> = {}): ShapeElement =>
  ({
    id,
    type: "rectangle",
    x1: x,
    y1: 0,
    x2: x + 10,
    y2: 10,
    stroke: "#000000",
    fill: null,
    ...fields,
  }) as unknown as ShapeElement;

const sam = { userId: "g_sam", name: "Sam", guest: true };
const kim = { userId: "u_kim", name: "Kim", guest: false, color: "#1971c2" };

const add = (id: string, at = 0, author = sam): Suggestion => ({
  id: `add:${id}`,
  kind: "add",
  element: rect(id, 100),
  author,
  createdAt: at,
  updatedAt: at,
});
const change = (target: Element, proposed: Element, at = 0, author = sam): Suggestion => ({
  id: `on:${author.userId}:${target.id}`,
  kind: "change",
  target: target.id,
  element: proposed,
  groups: ["shape"],
  base: stampsOf(target, ["shape"]),
  author,
  createdAt: at,
  updatedAt: at,
});
const removal = (target: Element, at = 0, author = sam): Suggestion => ({
  id: `on:${author.userId}:${target.id}`,
  kind: "remove",
  target: target.id,
  base: stampsOf(target),
  author,
  createdAt: at,
  updatedAt: at,
});

describe("the suggestion store", () => {
  it("keeps suggestions oldest first, replacing by id, and tells subscribers", () => {
    const store = createSuggestionStore();
    let told = 0;
    store.subscribe(() => (told += 1));
    store.load([add("b", 20)]);
    store.upsert([add("a", 10), { ...add("b", 20), updatedAt: 30 }]);
    assert.deepEqual(
      store.getSnapshot().map((suggestion) => [suggestion.id, suggestion.updatedAt]),
      [
        ["add:a", 10],
        ["add:b", 30],
      ],
    );
    store.remove(["add:a", "add:missing"]);
    assert.deepEqual(
      store.getSnapshot().map((suggestion) => suggestion.id),
      ["add:b"],
    );
    store.remove(["add:missing"]);
    assert.equal(told, 3, "removing nothing tells nobody");
  });
});

describe("groupSuggestions", () => {
  it("puts one person's suggestions made close together in a group, keeping people apart", () => {
    const groups = groupSuggestions([
      add("a", 0),
      add("b", 1000, kim),
      add("c", GROUP_GAP_MS),
      add("d", GROUP_GAP_MS * 3),
    ]);
    assert.deepEqual(
      groups.map((group) => [group.author.name, group.suggestions.map((suggestion) => suggestion.id)]),
      [
        ["Sam", ["add:a", "add:c"]],
        ["Kim", ["add:b"]],
        ["Sam", ["add:d"]],
      ],
    );
    assert.equal(groups[0]!.id, "add:a");
  });

  it("says what a group suggests in a few words", () => {
    const box = rect("box");
    assert.equal(summarize([add("a"), add("b"), removal(box)]), "Adds 2, removes 1");
    assert.equal(summarize([change(box, rect("box", 5))]), "Changes 1");
  });
});

describe("accepting suggestions", () => {
  it("is one undoable edit: additions keep their ids, changes take only their groups, removals happen", () => {
    const store = createBoardStore();
    const box = rect("box", 0, { stroke: "#000000" });
    const old = rect("old", 50);
    store.load([box, old]);
    // Someone recolors the box after the move was suggested; accepting the move keeps the color.
    store.commit({ undo: { upsert: [box] }, redo: { upsert: [{ ...box, stroke: "#e03131" } as Element] } });

    const { entry, accepted, skipped } = acceptance([add("new"), change(box, rect("box", 30)), removal(old)], (id) =>
      store.getElement(id),
    );
    assert.deepEqual(skipped, []);
    assert.equal(accepted.length, 3);
    store.commit(entry);

    const moved = store.getElement("box") as ShapeElement;
    assert.equal(moved.x1, 30);
    assert.equal(moved.stroke, "#e03131");
    assert.ok(store.getElement("new"));
    assert.equal(store.getElement("old"), undefined);

    store.undo();
    assert.equal((store.getElement("box") as ShapeElement).x1, 0);
    assert.equal((store.getElement("box") as ShapeElement).stroke, "#e03131");
    assert.equal(store.getElement("new"), undefined);
    assert.ok(store.getElement("old"));
  });

  it("leaves out suggestions about an element that went, and additions already on the board", () => {
    const store = createBoardStore();
    store.load([rect("there")]);
    const gone = rect("gone");
    const { accepted, skipped } = acceptance([add("there"), removal(gone), change(gone, rect("gone", 5))], (id) =>
      store.getElement(id),
    );
    assert.deepEqual(accepted, []);
    assert.deepEqual(skipped, ["add:there", "on:g_sam:gone", "on:g_sam:gone"]);
  });

  it("takes several people's changes to one element onto each other, in order", () => {
    const store = createBoardStore();
    const box = rect("box");
    store.load([box]);
    const fromSam = change(box, rect("box", 30));
    const fromKim: Suggestion = {
      ...change(box, rect("box", 0, { stroke: "#1971c2" }), 5, kim),
      groups: ["stroke"],
    } as Suggestion;
    const { entry } = acceptance([fromSam, fromKim], (id) => store.getElement(id));
    store.commit(entry);
    const result = store.getElement("box") as ShapeElement;
    assert.equal(result.x1, 30);
    assert.equal(result.stroke, "#1971c2");
  });
});

describe("suggestionMarks", () => {
  it("draws additions as suggested, changes taken onto the element, removals on it, and skips what went", () => {
    const box = rect("box");
    const elements = new Map([["box", box as Element]]);
    const marks = suggestionMarks(
      [add("new", 0, kim), change(box, rect("box", 40)), removal(rect("gone"))],
      (id) => elements.get(id),
      new Set(["add:new"]),
    );
    assert.deepEqual(
      marks.map((mark) => [mark.id, mark.kind, mark.highlighted]),
      [
        ["add:new", "add", true],
        ["on:g_sam:box", "change", false],
      ],
    );
    assert.equal(marks[0]!.color, "#1971c2", "in the author's color");
    assert.equal((marks[1]!.element as ShapeElement).x1, 40);
    assert.equal(marks[1]!.outdated, false);
  });
});
