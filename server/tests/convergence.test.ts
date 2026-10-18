import assert from "node:assert/strict";
import { register } from "node:module";
import { describe, it } from "node:test";
import { commitPlan, effectOf, groupsOf, planOperation, withStamps } from "@inkboard/shared/board-merge";
import { followText, withoutBase } from "@inkboard/shared/text-merge";
import type { Typing } from "@inkboard/shared/text-merge";
import type { Effect, Element, FrameElement, ShapeElement, StickyElement, Tombstones } from "@inkboard/shared/types";
import type { AckReply, Outbox, Piece } from "../../client/src/features/board/outbox.ts";
import { createBoardStore } from "../../client/src/features/board/store.ts";
import type { BoardStore } from "../../client/src/features/board/store.ts";
import { mergedTyping, prepareOperation, sanitizeOperation } from "../src/realtime/operations.ts";
import type { FullOperation } from "../src/realtime/operations.ts";
import { rect } from "./helpers.ts";

// The browser's outbox imports app modules without their file endings, as Vite allows: the client's tests find them
// with these hooks.
register("../../client/tests/resolve-hooks.js", import.meta.url);
const { createOutbox } = await import("../../client/src/features/board/outbox.ts");

// People edit the same elements at the same time, and their changes reach the
// server, and each other, in different orders. Whatever the order, everyone
// must end up with the same board as the server: the same elements, with the
// same properties, stacked the same way. This plays that out with the real
// browser store and the real server rules: three people adding, dragging,
// recoloring, removing, undoing and redoing, with messages delivered in a
// random order (each connection keeps its own order, as a socket does).

function random(seed: number) {
  let state = seed >>> 0;
  return () => {
    state = (state * 1664525 + 1013904223) >>> 0;
    return state / 2 ** 32;
  };
}

const COLORS = ["#ff0000", "#00aa00", "#0000ff", "#222222"];

interface SimClient {
  number: number;
  store: ReturnType<typeof createBoardStore>;
  outbox: FullOperation[];
  inbox: Effect[];
  made: number;
}

function play(seed: number) {
  const next = random(seed);
  const pick = <T>(list: readonly T[] | T[]) => list[Math.floor(next() * list.length)];
  const server: { elements: Element[]; tombstones: Tombstones } = { elements: [], tombstones: new Map() };

  const clients: SimClient[] = Array.from({ length: 3 }, (_, number) => {
    const store = createBoardStore();
    store.load([]);
    const client: SimClient = { number, store, outbox: [], inbox: [], made: 0 };
    store.setBroadcaster((op: Effect) => client.outbox.push(op as unknown as FullOperation));
    return client;
  });

  // The server takes a change in exactly as the board:op handler does.
  function serverReceives(from: SimClient, sent: FullOperation) {
    const op = prepareOperation(server.elements, sent, server.tombstones);
    const plan = planOperation(server.elements, op, server.tombstones);
    const effect = effectOf(plan);
    server.elements = commitPlan(plan, server.tombstones).elements;
    if (effect.upsert.length === 0 && effect.remove.length === 0) return;
    for (const client of clients) if (client !== from) client.inbox.push(effect);
  }

  function deliverOne() {
    const ready = [];
    for (const client of clients) {
      if (client.outbox.length > 0) ready.push(() => serverReceives(client, client.outbox.shift()!));
      if (client.inbox.length > 0) ready.push(() => client.store.applyRemote(client.inbox.shift()!));
    }
    if (ready.length === 0) return false;
    pick(ready)();
    return true;
  }

  // One person does one thing, the way the editor does it.
  function act(client: SimClient) {
    const { store } = client;
    const elements = store.getElements();
    const target = elements.length > 0 ? pick(elements) : null;
    const roll = next();
    if (roll < 0.12) return store.undo();
    if (roll < 0.17) return store.redo();
    if (!target || roll < 0.32) {
      client.made += 1;
      const id = `p${client.number}-${client.made}`;
      return store.commit({ undo: { remove: [id] }, redo: { upsert: [rect(id, Math.floor(next() * 500))] } });
    }
    if (roll < 0.45) return store.commit({ undo: { upsert: [target] }, redo: { remove: [target.id] } });
    if (roll < 0.62) {
      const key = next() < 0.5 ? "stroke" : "fill";
      return store.commit(
        { undo: { upsert: [target] }, redo: { upsert: [{ ...target, [key]: pick(COLORS) }] } },
        { mergeKey: `style:${target.id}:${key}` },
      );
    }
    // A drag: a few steps, each made from the one before, with deliveries in between.
    let previous = target;
    const steps = 1 + Math.floor(next() * 3);
    for (let step = 1; step <= steps; step += 1) {
      const dx = step * 7;
      const moved = { ...target, x1: (target as ShapeElement).x1 + dx, x2: (target as ShapeElement).x2 + dx };
      store.apply({ upsert: [moved] }, { base: [previous] });
      previous = moved;
      if (next() < 0.5) deliverOne();
    }
    store.record({ undo: { upsert: [target] }, redo: { upsert: [previous] } });
  }

  for (let step = 0; step < 90; step += 1) {
    if (next() < 0.45) act(pick(clients));
    else deliverOne();
  }
  while (deliverOne());

  return { server: server.elements, clients: clients.map((client) => client.store.getElements()) };
}

describe("everyone ends up with the same board", () => {
  it("whatever order 400 sessions of adding, dragging, recoloring, removing and undoing arrive in", () => {
    for (let seed = 1; seed <= 400; seed += 1) {
      const { server, clients } = play(seed);
      clients.forEach((client, index) => {
        assert.deepEqual(client, server, `person ${index + 1} disagrees with the server in session ${seed}`);
      });
    }
  });

  it("including the order things are stacked in", () => {
    let stacked = 0;
    for (let seed = 1; seed <= 100; seed += 1) {
      const { server, clients } = play(seed);
      const order = server.map((element: Element) => element.id).join();
      for (const client of clients)
        assert.equal(client.map((element: Element) => element.id).join(), order, `session ${seed}`);
      if (server.length > 2) stacked += 1;
    }
    assert.ok(stacked > 50, "most sessions end with a few elements to stack");
  });
});

// Several people typing into the same sticky note at once, the way the editor has them: each opens
// it, types and deletes at places of their own or the same places, and commits when done (on blur).
// While they type, others' typing reaches them and is merged into what they're typing. Some type
// into a frame's name too, from the properties panel, where every letter is committed as it's
// typed; and some undo, or recolor the note. The server answers each sender with the text it
// merged theirs into. Each person types letters of their own, so what survives can be counted.

const LETTERS = ["abcdef", "ABCDEF", "123456"];

// Every group of `element` stamped as the board's first edit.
const firstEdit = <T extends Element>(element: T): T =>
  withStamps(
    element,
    Object.fromEntries(groupsOf(element).map((group) => [group, { version: 1, versionNonce: 7 }])),
  ) as T;
const NOTE = firstEdit({
  id: "note",
  type: "sticky",
  x1: 0,
  y1: 0,
  x2: 200,
  y2: 200,
  text: "~ ~ ~",
  fill: "#ffec99",
  font: "hand",
  index: "a0",
} as StickyElement);
const FRAME = firstEdit({
  id: "frame",
  type: "frame",
  x1: -50,
  y1: -50,
  x2: 400,
  y2: 400,
  name: "##",
  index: "a1",
} as FrameElement);

interface Typist {
  letters: string;
  store: BoardStore;
  outbox: Outbox;
  // Pieces sent, on their way to the server, and what the server sent back, in order (as a socket keeps it).
  sent: Piece[];
  inbox: (Effect | { seq: number; reply: AckReply })[];
  typing: Typing | null;
  typed: number;
}

const noteText = (store: BoardStore) => (store.getElement("note") as StickyElement).text;

function playTyping(seed: number, { merge = true, deletes = true } = {}) {
  const next = random(seed);
  const pick = <T>(list: readonly T[]) => list[Math.floor(next() * list.length)]!;
  const letterOf = (letters: string) => letters[Math.floor(next() * letters.length)]!;
  const upTo = (most: number) => Math.floor(next() * (most + 1));
  const server: { elements: Element[]; tombstones: Tombstones } = { elements: [NOTE, FRAME], tombstones: new Map() };

  // As useBoardSync has it: what's typed goes to the outbox, which sends it, and is told of each reply. Without
  // `merge`, changes go as browsers sent them before typing was merged: without bases.
  const people: Typist[] = LETTERS.map((letters) => {
    const store = createBoardStore();
    store.load([NOTE, FRAME]);
    const person: Typist = { letters, store, outbox: createOutbox(), sent: [], inbox: [], typing: null, typed: 0 };
    store.setBroadcaster((op: Effect) => person.outbox.add(merge ? op : { ...op, upsert: op.upsert.map(withoutBase) }));
    return person;
  });

  // As the board:op handler takes a change in: sent as JSON, cleaned, prepared, planned and committed. The others
  // are sent what changed, and the sender the typing the board merged with others'.
  function serverReceives(from: Typist, { seq, op: sent }: Piece) {
    // The assertion: every change sent here has something in it, which sanitizeOperation keeps.
    const clean = sanitizeOperation(JSON.parse(JSON.stringify(sent)))!;
    const op = prepareOperation(server.elements, clean, server.tombstones);
    const plan = planOperation(server.elements, op, server.tombstones);
    const effect = effectOf(plan);
    server.elements = commitPlan(plan, server.tombstones).elements;
    const stored = (id: string) => server.elements.find((element) => element.id === id);
    const cleaned = mergedTyping(op.upsert, stored);
    from.inbox.push({ seq, reply: { ok: true, ...(cleaned.length > 0 && { cleaned }) } });
    if (effect.upsert.length === 0 && effect.remove.length === 0) return;
    for (const person of people) if (person !== from) person.inbox.push(effect);
  }

  // A message from the server reaches `person` (as useBoardSync takes it), and their editor, if it's open, takes
  // in the note as it now is.
  function receive(person: Typist) {
    const { store, outbox } = person;
    const message = person.inbox.shift()!;
    if ("reply" in message) {
      const result = outbox.settle(message.seq, null, message.reply);
      assert.equal(result.kind, "ok");
      if (result.kind === "ok" && result.cleaned.length > 0) store.reconcile({ ...result, typing: outbox.typing() });
    } else store.applyRemote(message, outbox.typing());
    if (person.typing) person.typing = followText(person.typing, noteText(store));
  }

  function deliverOne() {
    const ready = [];
    for (const person of people) {
      if (person.outbox.hasPending()) ready.push(() => person.sent.push(person.outbox.take()!));
      if (person.sent.length > 0) ready.push(() => serverReceives(person, person.sent.shift()!));
      if (person.inbox.length > 0) ready.push(() => receive(person));
    }
    if (ready.length === 0) return false;
    pick(ready)();
    return true;
  }

  // As the editor commits (see commitText in BoardEditor.tsx).
  function commit(person: Typist) {
    const { value, base } = person.typing!;
    person.typing = null;
    const current = person.store.getElement("note") as StickyElement;
    if (value === base || value === current.text) return;
    person.store.commit({
      undo: { upsert: [{ ...current, text: base }] },
      redo: { upsert: [{ ...current, text: value }] },
    });
  }

  function act(person: Typist) {
    const { store, typing } = person;
    const roll = next();
    if (!typing) {
      if (roll < 0.45) {
        const text = noteText(store);
        const at = upTo(text.length);
        person.typing = { value: text, base: text, start: at, end: at };
        return;
      }
      if (roll < 0.65) {
        const frame = store.getElement("frame") as FrameElement;
        const at = upTo(frame.name.length);
        const name = frame.name.slice(0, at) + letterOf(person.letters) + frame.name.slice(at);
        person.typed += 1;
        return store.commit({ undo: { upsert: [frame] }, redo: { upsert: [{ ...frame, name }] } });
      }
      if (deletes && roll < 0.8) return next() < 0.7 ? store.undo() : store.redo();
      const note = store.getElement("note") as StickyElement;
      return store.commit(
        { undo: { upsert: [note] }, redo: { upsert: [{ ...note, fill: pick(COLORS) }] } },
        { mergeKey: "style:note:fill" },
      );
    }
    if (roll < 0.15) return commit(person);
    if (roll < 0.3) {
      typing.start = typing.end = upTo(typing.value.length);
      return;
    }
    if (deletes && roll < 0.5) {
      const start = upTo(typing.value.length);
      const end = Math.min(typing.value.length, start + 1 + upTo(3));
      typing.value = typing.value.slice(0, start) + typing.value.slice(end);
      typing.start = typing.end = start;
      return;
    }
    const word = Array.from({ length: 1 + upTo(2) }, () => letterOf(person.letters)).join("");
    typing.value = typing.value.slice(0, typing.start) + word + typing.value.slice(typing.end);
    typing.start = typing.end = typing.start + word.length;
    person.typed += word.length;
  }

  for (let step = 0; step < 150; step += 1) {
    if (next() < 0.5) act(pick(people));
    else deliverOne();
  }
  for (const person of people) if (person.typing) commit(person);
  while (deliverOne());

  // How many of each person's letters are on the board, in the note and the frame's name.
  const note = server.elements.find((element) => element.id === "note") as StickyElement;
  const frame = server.elements.find((element) => element.id === "frame") as FrameElement;
  const board = [...note.text, ...frame.name];
  return {
    server: server.elements,
    people: people.map((person) => person.store.getElements()),
    note: note.text,
    typed: people.map((person) => person.typed),
    kept: people.map(({ letters }) => board.filter((letter) => letters.includes(letter)).length),
  };
}

describe("everyone ends up with the same text", () => {
  it("whatever order 500 sessions of three people typing in one note and a frame's name arrive in", () => {
    for (let seed = 1; seed <= 500; seed += 1) {
      const { server, people } = playTyping(seed);
      people.forEach((elements, index) => {
        assert.deepEqual(elements, server, `person ${index + 1} disagrees with the server in session ${seed}`);
      });
    }
  });

  it("keeping every letter everyone typed, when nothing is deleted", () => {
    let together = 0;
    for (let seed = 1; seed <= 300; seed += 1) {
      const { server, people, note, typed, kept } = playTyping(seed, { deletes: false });
      for (const elements of people) assert.deepEqual(elements, server, `session ${seed}`);
      assert.deepEqual(kept, typed, `session ${seed}: letters kept of those typed, by person`);
      if (LETTERS.filter((letters) => [...letters].some((letter) => note.includes(letter))).length > 1) together += 1;
    }
    assert.ok(together > 200, `most sessions end with more than one person's typing in the note (${together})`);
  });

  it("where the newer text winning whole lost some (and still agreed)", () => {
    let lost = 0;
    for (let seed = 1; seed <= 300; seed += 1) {
      const { server, people, typed, kept } = playTyping(seed, { merge: false, deletes: false });
      for (const elements of people) assert.deepEqual(elements, server, `session ${seed}`);
      if (kept.some((count, index) => count < typed[index]!)) lost += 1;
    }
    assert.ok(lost > 150, `most sessions lose someone's typing without merging (${lost})`);
  });
});
