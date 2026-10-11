import assert from "node:assert/strict";
import { describe, it } from "node:test";
import type { SuggestionPutReply } from "@inkboard/shared/socket";
import { changedGroups, stampsOf, suggestionId } from "@inkboard/shared/suggestions";
import type { Suggestion, SuggestionDraft } from "@inkboard/shared/suggestions";
import type { Effect, Element, ShapeElement } from "@inkboard/shared/types";
import { createBoardStore } from "../src/features/board/store.ts";
import type { BoardStore } from "../src/features/board/store.ts";
import { createSuggester } from "../src/features/board/suggesting.ts";
import { createSuggestionStore } from "../src/features/board/suggestions.ts";

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
    version: 1,
    versionNonce: 1,
    ...fields,
  }) as unknown as ShapeElement;

const me = { userId: "g_me", name: "Me", guest: true };

/**
 * A suggester on a board with `elements`, and a stand-in for the server: it keeps what it's sent the way the real
 * one does (roughly), answers with `answer` when given one, and remembers every message.
 */
function setup(elements: Element[] = [rect("box")], answer?: (drafts: SuggestionDraft[]) => SuggestionPutReply) {
  const store = createBoardStore();
  const suggestions = createSuggestionStore();
  const sent: { drafts: SuggestionDraft[]; withdraw: string[] }[] = [];
  const refused: string[][] = [];
  const keep = (drafts: SuggestionDraft[]): SuggestionPutReply => {
    const kept: Suggestion[] = [];
    const withdrawn: string[] = [];
    for (const draft of drafts) {
      const common = { author: me, createdAt: 1, updatedAt: 1 };
      if (draft.kind === "add") {
        kept.push({
          ...common,
          id: suggestionId("add", me.userId, draft.element.id),
          kind: "add",
          element: draft.element,
        });
      } else if (draft.kind === "change") {
        const current = suggester.board.getElement(draft.element.id)!;
        const groups = changedGroups(current, { ...draft.element, index: current.index });
        const id = suggestionId("change", me.userId, current.id);
        if (groups.length === 0) withdrawn.push(id);
        else {
          kept.push({
            ...common,
            id,
            kind: "change",
            target: current.id,
            element: draft.element,
            groups,
            base: stampsOf(current, groups),
          });
        }
      } else {
        const current = suggester.board.getElement(draft.target)!;
        kept.push({
          ...common,
          id: suggestionId("remove", me.userId, draft.target),
          kind: "remove",
          target: draft.target,
          base: stampsOf(current),
        });
      }
    }
    return { ok: true, suggestions: kept, ...(withdrawn.length > 0 ? { withdrawn } : {}) };
  };
  const suggester = createSuggester({
    store,
    suggestions,
    isOwn: (suggestion) => suggestion.author.userId === me.userId,
    send: async (drafts, withdraw) => {
      sent.push({ drafts, withdraw });
      return (answer ?? keep)(drafts);
    },
    onRefused: ({ dropped }) => refused.push(dropped),
    delay: 60_000, // sent by calling flush in these tests
  });
  store.setBroadcaster((op: Effect) => suggester.take(op));
  store.load(elements);
  suggester.joined(elements, []);
  return { store, suggestions, suggester, sent, refused };
}

const shape = (store: BoardStore, id: string) => store.getElement(id) as ShapeElement | undefined;

describe("suggesting", () => {
  it("sends a new element as an addition, and keeps it on the suggester's screen", async () => {
    const { store, suggestions, suggester, sent } = setup();
    store.commit({ undo: { remove: ["idea"] }, redo: { upsert: [rect("idea", 50)] } });
    await suggester.flush();
    assert.deepEqual(
      sent[0]!.drafts.map((draft) => draft.kind),
      ["add"],
    );
    assert.deepEqual(
      suggestions.getSnapshot().map((suggestion) => suggestion.id),
      ["add:idea"],
    );
    assert.ok(shape(store, "idea"), "still drawn here");
    assert.equal(suggester.board.getElement("idea"), undefined, "not on the board");
  });

  it("sends an edit of a board element as a change, and taking it away as a removal", async () => {
    const { store, suggester, sent } = setup([rect("box"), rect("other", 50)]);
    store.commit({ undo: { upsert: [rect("box")] }, redo: { upsert: [rect("box", 30)] } });
    store.commit({ undo: { upsert: [rect("other", 50)] }, redo: { remove: ["other"] } });
    await suggester.flush();
    assert.deepEqual(
      sent[0]!.drafts.map((draft) => [draft.kind, draft.kind === "remove" ? draft.target : draft.element.id]),
      [
        ["change", "box"],
        ["remove", "other"],
      ],
    );
    assert.equal(shape(store, "box")!.x1, 30);
    assert.equal(shape(suggester.board, "box")!.x1, 0, "the board itself is unchanged");
  });

  it("takes back an addition the suggester removes again, and a change they undo", async () => {
    const { store, suggestions, suggester, sent } = setup();
    store.commit({ undo: { remove: ["idea"] }, redo: { upsert: [rect("idea", 50)] } });
    store.commit({ undo: { upsert: [rect("box")] }, redo: { upsert: [rect("box", 30)] } });
    await suggester.flush();
    assert.equal(suggestions.getSnapshot().length, 2);

    store.undo(); // the move: the box is as it is on the board again
    store.undo(); // the new element
    await suggester.flush();
    assert.deepEqual(sent[1]!.withdraw, ["add:idea"]);
    assert.deepEqual(
      sent[1]!.drafts.map((draft) => draft.kind),
      ["change"],
    );
    assert.deepEqual(suggestions.getSnapshot(), [], "the server took the change back, as it was the board's");
  });

  it("shows the suggester's suggestions over the board when they open it", () => {
    const { store, suggestions, suggester } = setup();
    const box = rect("box");
    suggestions.load([
      { id: "add:idea", kind: "add", element: rect("idea", 80), author: me, createdAt: 1, updatedAt: 1 },
      {
        id: "on:g_me:box",
        kind: "change",
        target: "box",
        element: rect("box", 40),
        groups: ["shape"],
        base: stampsOf(box, ["shape"]),
        author: me,
        createdAt: 1,
        updatedAt: 1,
      },
      // Someone else's are drawn over the board, not put in it.
      {
        id: "add:theirs",
        kind: "add",
        element: rect("theirs"),
        author: { ...me, userId: "g_other" },
        createdAt: 1,
        updatedAt: 1,
      },
    ]);
    store.load([box]);
    suggester.joined([box], []);
    assert.equal(shape(store, "box")!.x1, 40);
    assert.ok(shape(store, "idea"));
    assert.equal(shape(store, "theirs"), undefined);
  });

  it("keeps the board live under a suggestion: someone recoloring the box the suggester moved shows both", async () => {
    const { store, suggester } = setup();
    store.commit({ undo: { upsert: [rect("box")] }, redo: { upsert: [rect("box", 30)] } });
    await suggester.flush();
    // The owner recolors the box (from the board as they have it), and it reaches the suggester's screen.
    const recolored = { ...rect("box"), stroke: "#e03131", version: 2, versionNonce: 5, stamps: { shape: [1, 1] } };
    const op = { upsert: [recolored as unknown as Element], remove: [] };
    store.applyRemote(op);
    suggester.remote(op);
    assert.equal(shape(store, "box")!.x1, 30, "the suggested move");
    assert.equal(shape(store, "box")!.stroke, "#e03131", "and the owner's color");
    assert.equal(shape(suggester.board, "box")!.x1, 0);
  });

  it("puts the board back when a suggestion goes (rejected, or its element removed), keeping history", async () => {
    const { store, suggestions, suggester } = setup([rect("box"), rect("other", 50)]);
    store.commit({ undo: { upsert: [rect("box")] }, redo: { upsert: [rect("box", 30)] } });
    store.commit({ undo: { upsert: [rect("other", 50)] }, redo: { upsert: [rect("other", 90)] } });
    await suggester.flush();

    // A member rejects the move of the box.
    suggestions.remove(["on:g_me:box"]);
    suggester.rebuild();
    assert.equal(shape(store, "box")!.x1, 0, "back as it is on the board");
    assert.equal(shape(store, "other")!.x1, 90, "the other suggestion stays");
    assert.equal(store.getSnapshot().canUndo, true, "history is kept");

    // The owner deletes the other element: its change goes, and so does the element.
    const removal = { upsert: [], remove: [{ id: "other", version: 5, versionNonce: 1 }] };
    store.applyRemote(removal);
    suggester.remote(removal);
    suggestions.remove(["on:g_me:other"]);
    suggester.rebuild();
    assert.equal(shape(store, "other"), undefined);
  });

  it("undoes, here, what the server left out, and says so", async () => {
    const { store, suggester, refused } = setup([rect("box")], (drafts) => ({
      ok: true,
      suggestions: [],
      dropped: drafts.map((draft) => (draft.kind === "remove" ? draft.target : draft.element.id)),
    }));
    store.commit({ undo: { remove: ["pic"] }, redo: { upsert: [rect("pic", 50)] } });
    await suggester.flush();
    assert.equal(shape(store, "pic"), undefined);
    assert.deepEqual(refused, [["pic"]]);
  });

  it("sends again later when the server asks it to slow down, without losing what was drawn", async () => {
    let calls = 0;
    const { store, suggester, sent } = setup([rect("box")], () => {
      calls += 1;
      return calls === 1 ? { ok: false, reason: "rate" } : { ok: true, suggestions: [] };
    });
    store.commit({ undo: { remove: ["idea"] }, redo: { upsert: [rect("idea", 50)] } });
    await suggester.flush();
    assert.ok(shape(store, "idea"), "still drawn while waiting");
    suggester.rebuild(); // anything that shows the board again keeps it too
    assert.ok(shape(store, "idea"));
    await suggester.flush();
    assert.equal(sent.length, 2);
    assert.equal(sent[1]!.drafts[0]!.kind, "add");
    suggester.stop();
  });

  it("sends again after being stopped and started, as when React puts a screen back", async () => {
    const { store, suggester, sent } = setup();
    suggester.stop();
    suggester.start();
    store.commit({ undo: { remove: ["idea"] }, redo: { upsert: [rect("idea", 50)] } });
    await suggester.flush();
    assert.equal(sent.length, 1);
    suggester.stop();
  });
});
