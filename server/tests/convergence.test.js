import assert from "node:assert/strict";
import { describe, it } from "node:test";
import { commitPlan, effectOf, planOperation } from "@inkboard/shared/board-merge";
import { createBoardStore } from "../../client/src/features/board/store.js";
import { prepareOperation } from "../src/realtime/operations.js";
import { rect } from "./helpers.js";

// People edit the same elements at the same time, and their changes reach the
// server, and each other, in different orders. Whatever the order, everyone
// must end up with the same board as the server: the same elements, with the
// same properties, stacked the same way. This plays that out with the real
// browser store and the real server rules: three people adding, dragging,
// recoloring, removing, undoing and redoing, with messages delivered in a
// random order (each connection keeps its own order, as a socket does).

function random(seed) {
  let state = seed >>> 0;
  return () => {
    state = (state * 1664525 + 1013904223) >>> 0;
    return state / 2 ** 32;
  };
}

const COLORS = ["#ff0000", "#00aa00", "#0000ff", "#222222"];

function play(seed) {
  const next = random(seed);
  const pick = (list) => list[Math.floor(next() * list.length)];
  const server = { elements: [], tombstones: new Map() };

  const clients = Array.from({ length: 3 }, (_, number) => {
    const store = createBoardStore();
    store.load([]);
    const client = { number, store, outbox: [], inbox: [], made: 0 };
    store.setBroadcaster((op) => client.outbox.push(op));
    return client;
  });

  // The server takes a change in exactly as the board:op handler does.
  function serverReceives(from, sent) {
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
      if (client.outbox.length > 0) ready.push(() => serverReceives(client, client.outbox.shift()));
      if (client.inbox.length > 0) ready.push(() => client.store.applyRemote(client.inbox.shift()));
    }
    if (ready.length === 0) return false;
    pick(ready)();
    return true;
  }

  // One person does one thing, the way the editor does it.
  function act(client) {
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
      return store.commit({ undo: { upsert: [target] }, redo: { upsert: [{ ...target, [key]: pick(COLORS) }] } }, { mergeKey: `style:${target.id}:${key}` });
    }
    // A drag: a few steps, each made from the one before, with deliveries in between.
    let previous = target;
    const steps = 1 + Math.floor(next() * 3);
    for (let step = 1; step <= steps; step += 1) {
      const dx = step * 7;
      const moved = { ...target, x1: target.x1 + dx, x2: target.x2 + dx };
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
      const order = server.map((element) => element.id).join();
      for (const client of clients) assert.equal(client.map((element) => element.id).join(), order, `session ${seed}`);
      if (server.length > 2) stacked += 1;
    }
    assert.ok(stacked > 50, "most sessions end with a few elements to stack");
  });
});
