import assert from "node:assert/strict";
import { register } from "node:module";
import { describe, it } from "node:test";

// useBoardSync run in Node, without a browser: React, the toasts and the socket it gets from
// SocketProvider are swapped for small stand-ins (only for this file), so what the hook sends
// and does can be checked against a fake connection.
const fakes = {
  react: `
    const state = (globalThis.__react = { slots: [], effects: [], cleanups: [], at: 0 });
    export function render(hook) {
      state.at = 0;
      state.effects = [];
      const out = hook();
      for (const effect of state.effects) {
        const cleanup = effect();
        if (typeof cleanup === "function") state.cleanups.push(cleanup);
      }
      return out;
    }
    export function unmount() {
      for (const cleanup of state.cleanups.splice(0).reverse()) cleanup();
    }
    const slot = (make) => {
      const at = state.at++;
      if (!(at in state.slots)) state.slots[at] = make();
      return state.slots[at];
    };
    export function useState(initial) {
      const kept = slot(() => ({ value: typeof initial === "function" ? initial() : initial }));
      return [kept.value, (next) => { kept.value = typeof next === "function" ? next(kept.value) : next; }];
    }
    export const useRef = (initial) => slot(() => ({ current: initial }));
    export const useCallback = (fn) => fn;
    export const useEffect = (effect) => { state.effects.push(effect); };
    export const useSyncExternalStore = (_subscribe, getSnapshot) => getSnapshot();
  `,
  sonner: `
    export const toast = Object.assign(() => {}, { error: (message) => globalThis.__toasts.push(message), success() {} });
  `,
  socket: `export const useSocket = () => globalThis.__socket;`,
};
const url = (source) => `data:text/javascript,${encodeURIComponent(source)}`;
register(
  url(`
    const fakes = ${JSON.stringify(Object.fromEntries(Object.entries(fakes).map(([name, source]) => [name, url(source)])))};
    export async function resolve(specifier, context, next) {
      if (specifier === "react") return { url: fakes.react, shortCircuit: true };
      if (specifier === "sonner") return { url: fakes.sonner, shortCircuit: true };
      if (specifier.endsWith("providers/SocketProvider")) return { url: fakes.socket, shortCircuit: true };
      return next(specifier, context);
    }
  `),
);

const { render, unmount } = await import("react");
const { useBoardSync } = await import("../src/features/board/useBoardSync.ts");
const { createBoardStore } = await import("../src/features/board/store.ts");

const wait = (ms) => new Promise((resolve) => setTimeout(resolve, ms));
const rect = (id) => ({ id, type: "rectangle", x1: 0, y1: 0, x2: 10, y2: 10, stroke: "#000000", fill: null });
const big = (id) => ({ ...rect(id), text: "x".repeat(400_000) });

/** A connection that records what's sent, and lets a test answer it and send events. */
function fakeSocket() {
  const handlers = new Map();
  const sent = [];
  const socket = {
    id: "me",
    connected: true,
    sent,
    on: (event, handler) => handlers.set(event, [...(handlers.get(event) ?? []), handler]),
    off: (event, handler) =>
      handlers.set(
        event,
        (handlers.get(event) ?? []).filter((h) => h !== handler),
      ),
    emit: (event, payload, ack) => sent.push({ event, payload, ack }),
    timeout: () => ({ emit: (event, payload, ack) => sent.push({ event, payload, ack, timed: true }) }),
    volatile: { emit: (event, payload) => sent.push({ event, payload }) },
    fire: (event, ...args) => {
      for (const handler of handlers.get(event) ?? []) handler(...args);
    },
    of: (event) => sent.filter((entry) => entry.event === event),
  };
  return socket;
}

/** The hook on board "b1" (or `boardId`, which the server names `canonical`), joined. */
function open(boardId = "b1", canonical = boardId) {
  globalThis.__react.slots = [];
  globalThis.__toasts = [];
  const socket = fakeSocket();
  globalThis.__socket = socket;
  const store = createBoardStore();
  const sync = render(() => useBoardSync(boardId, store));
  const [join] = socket.of("board:join");
  join.ack({ ok: true, board: { id: canonical, title: "B", role: "owner", elements: [] }, removed: [] });
  const phase = () => globalThis.__react.slots.find((kept) => kept?.value?.name)?.value;
  return { socket, store, sync, phase };
}

describe("useBoardSync", () => {
  it("sends the rest of a change in pieces, and what's queued, before leaving the board", async () => {
    const { socket, store } = open();
    store.apply({ upsert: [big("a"), big("b"), big("c")] });
    await wait(60);
    const [first] = socket.of("board:op");
    assert.equal(first.payload.group.index, 0);
    store.apply({ remove: ["a"] }); // waits for the change in pieces
    await wait(60);
    assert.equal(socket.of("board:op").length, 1);
    unmount();
    const after = socket.sent
      .slice(socket.sent.indexOf(first) + 1)
      .map(({ event, payload }) => [event, payload?.group?.index ?? payload?.op?.remove?.length]);
    assert.deepEqual(after, [
      ["board:op", 1],
      ["board:op", 1],
      ["board:leave", undefined],
    ]);
  });

  it("sends what waited for a change in pieces once its last piece is saved", async () => {
    const { socket, store } = open();
    store.apply({ upsert: [big("a"), big("b"), big("c")] });
    await wait(60);
    store.apply({ remove: ["a"] });
    await wait(60);
    socket.of("board:op")[0].ack(null, { ok: true });
    socket.of("board:op")[1].ack(null, { ok: true });
    await wait(10);
    const ops = socket.of("board:op");
    assert.equal(ops.length, 3);
    assert.deepEqual(
      ops[2].payload.op.remove.map((removal) => removal.id),
      ["a"],
    );
    unmount();
  });

  it("doesn't join a deleted board again when a late reply says it has no session", async () => {
    const { socket, store, phase } = open();
    store.apply({ upsert: [rect("a")] });
    await wait(60);
    socket.fire("board:deleted", { boardId: "b1" });
    socket.of("board:op")[0].ack(null, { ok: false, reason: "noSession" });
    socket.fire("connect");
    assert.equal(socket.of("board:join").length, 1);
    assert.equal(phase().name, "deleted");
    unmount();
  });

  it("does the same when access was taken away", () => {
    const { socket, phase } = open();
    socket.fire("board:revoked", { boardId: "b1" });
    socket.fire("connect");
    assert.equal(socket.of("board:join").length, 1);
    assert.equal(phase().name, "revoked");
    unmount();
  });

  it("leaves out events about another board", () => {
    const { socket, store, phase } = open();
    socket.fire("board:op", { boardId: "other", op: { upsert: [{ ...rect("x"), version: 1, versionNonce: 0 }] } });
    socket.fire("board:deleted", { boardId: "other" });
    assert.equal(store.getElement("x"), undefined);
    assert.equal(phase().name, "ready");
    socket.fire("board:op", { boardId: "b1", op: { upsert: [{ ...rect("y"), version: 1, versionNonce: 0 }] } });
    assert.ok(store.getElement("y"));
    unmount();
  });

  it("takes events for a board opened by an address that spells its id in upper case", () => {
    // The server finds the board either way and names it as it does itself (lower case).
    const { socket, store, phase } = open("507F1F77BCF86CD799439011", "507f1f77bcf86cd799439011");
    socket.fire("board:op", {
      boardId: "507f1f77bcf86cd799439011",
      op: { upsert: [{ ...rect("y"), version: 1, versionNonce: 0 }] },
    });
    assert.ok(store.getElement("y"));
    socket.fire("board:op", {
      boardId: "507f1f77bcf86cd799439012",
      op: { upsert: [{ ...rect("z"), version: 1, versionNonce: 0 }] },
    });
    assert.equal(store.getElement("z"), undefined);
    socket.fire("board:deleted", { boardId: "507f1f77bcf86cd799439011" });
    assert.equal(phase().name, "deleted");
    unmount();
  });

  it("sends a view taken from someone as whose own it is, and never follows its own view back", async () => {
    const { socket, sync } = open();
    socket.fire("presence", [{ socketId: "me" }, { socketId: "lead" }], { boardId: "b1" });
    const seen = [];
    sync.subscribeViewport((view) => seen.push(view));
    const view = { x: 0, y: 0, zoom: 1, width: 800, height: 600 };
    // "lead" shows what "origin" sees; we follow "lead".
    socket.fire("viewport", { ...view, boardId: "b1", socketId: "lead", source: "origin" });
    socket.fire("viewport", { ...view, boardId: "b1", socketId: "lead", source: "me" }); // our own, come back
    assert.deepEqual(
      seen.map((entry) => entry.source),
      ["origin"],
    );
    sync.sendViewport(view, "lead");
    await wait(150);
    assert.equal(socket.of("viewport").at(-1).payload.source, "origin");
    sync.sendViewport(view); // stopped following, without moving: now it's our own
    await wait(150);
    assert.equal(socket.of("viewport").at(-1).payload.source, "me");
    unmount();
  });
});
