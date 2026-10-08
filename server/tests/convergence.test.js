import assert from "node:assert/strict";
import { describe, it } from "node:test";
import { applyOperation as clientApply, createBoardStore } from "../../client/src/features/board/store.js";
import { applyOperation, keepNewer } from "../src/realtime/operations.js";
import { rect } from "./helpers.js";

// People edit the same elements at the same time, and their changes reach the
// server, and each other, in different orders. Whatever the order, everyone
// must end up with the same board as the server. This plays that out with the
// real client store and the real server rules: three people editing, removing
// and undoing, with messages delivered in a random order (each connection
// keeps its own order, as a socket does).

function random(seed) {
  let state = seed >>> 0;
  return () => {
    state = (state * 1664525 + 1013904223) >>> 0;
    return state / 2 ** 32;
  };
}

const IDS = ["a", "b", "c"];
const byId = (elements) => Object.fromEntries(elements.map((element) => [element.id, element]));

/**
 * Plays one session and returns everyone's board. With `versioned: false`, the
 * server and browsers apply whatever arrives (the old way), to show it diverges.
 */
function play(seed, { versioned = true } = {}) {
  const next = random(seed);
  const start = IDS.map((id) => ({ ...rect(id), version: 1, versionNonce: 0 }));
  const server = { elements: start, tombstones: new Map() };

  const clients = Array.from({ length: 3 }, () => {
    const store = createBoardStore();
    store.load(start);
    const client = { store, outbox: [], inbox: [] };
    store.setBroadcaster((op) => client.outbox.push(op));
    return client;
  });

  function serverReceives(from, op) {
    let effective = op;
    if (versioned) {
      effective = keepNewer(server.elements, op, server.tombstones);
      if (effective.upsert.length === 0 && effective.remove.length === 0) return;
      server.elements = applyOperation(server.elements, effective, server.tombstones);
    } else {
      // The old way: apply whatever arrives, last write wins.
      const plain = { upsert: op.upsert, remove: op.remove.map((removal) => removal.id) };
      server.elements = clientApply(server.elements, plain);
      effective = plain;
    }
    for (const client of clients) if (client !== from) client.inbox.push(effective);
  }

  function deliverOne() {
    const ready = [];
    for (const client of clients) {
      if (client.outbox.length > 0) ready.push(() => serverReceives(client, client.outbox.shift()));
      if (client.inbox.length > 0) {
        ready.push(() => {
          const op = client.inbox.shift();
          if (versioned) client.store.applyRemote(op);
          else client.store.replace(clientApply(client.store.getElements(), op));
        });
      }
    }
    if (ready.length === 0) return false;
    ready[Math.floor(next() * ready.length)]();
    return true;
  }

  function edit(client) {
    const id = IDS[Math.floor(next() * IDS.length)];
    const current = client.store.getElement(id);
    const roll = next();
    if (roll < 0.2) client.store.undo();
    else if (!current) client.store.redo();
    else if (roll < 0.35) client.store.commit({ undo: { upsert: [current] }, redo: { remove: [id] } });
    else client.store.commit({ undo: { upsert: [current] }, redo: { upsert: [{ ...current, x1: Math.floor(next() * 1000) }] } });
  }

  for (let step = 0; step < 80; step += 1) {
    if (next() < 0.45) edit(clients[Math.floor(next() * clients.length)]);
    else deliverOne();
  }
  while (deliverOne());

  return { server: byId(server.elements), clients: clients.map((client) => byId(client.store.getElements())) };
}

describe("everyone ends up with the same board", () => {
  it("whatever order 400 sessions of crossing edits, removals and undos arrive in", () => {
    for (let seed = 1; seed <= 400; seed += 1) {
      const { server, clients } = play(seed);
      clients.forEach((client, index) => {
        assert.deepEqual(client, server, `person ${index + 1} disagrees with the server in session ${seed}`);
      });
    }
  });

  it("which the old way (apply whatever arrives) didn't manage", () => {
    let diverged = 0;
    for (let seed = 1; seed <= 400; seed += 1) {
      const { server, clients } = play(seed, { versioned: false });
      const same = (client) => JSON.stringify(Object.keys(client).sort()) === JSON.stringify(Object.keys(server).sort()) &&
        Object.keys(server).every((id) => client[id].x1 === server[id].x1);
      if (!clients.every(same)) diverged += 1;
    }
    assert.ok(diverged > 20, `the old way diverged in only ${diverged} of 400 sessions`);
  });
});
