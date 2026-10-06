import assert from "node:assert/strict";
import { after, before, describe, it } from "node:test";
import { Board } from "../src/models/board.model.js";
import {
  applyOperation,
  elementBytes,
  MAX_BOARD_BYTES,
  MAX_ELEMENT_BYTES,
  MAX_ELEMENTS_PER_BOARD,
  sanitizeOperation,
} from "../src/realtime/operations.js";
import { flushAllSessions } from "../src/realtime/index.js";
import { eventually, rect, remove, settle, startServer, upsert } from "./helpers.js";

let app;
before(async () => {
  app = await startServer();
});
after(() => app.stop());

const stored = async (boardId) => (await Board.findById(boardId).lean()).elements.map((element) => element.id);
const invite = (owner, id, person) => app.request(`/boards/${id}/collaborators`, { method: "POST", user: owner, body: { email: person.email } });

/** An owner and one invited editor, both on a fresh board. */
async function pair() {
  const owner = await app.signUp("Owner");
  const editor = await app.signUp("Editor");
  const id = await app.createBoard(owner);
  await invite(owner, id, editor);
  const a = await app.connect(owner);
  const b = await app.connect(editor);
  await a.join(id);
  await b.join(id);
  return { owner, editor, id, a, b };
}

describe("live drawing", () => {
  it("sends each change to everyone else on the board, but not back to the sender", async () => {
    const { id, a, b } = await pair();
    assert.deepEqual(await a.op(id, upsert(rect("one"), rect("two"))), { ok: true });

    const received = await eventually(() => b.of("board:op")[0], { message: "the operation" });
    assert.deepEqual(received.op.upsert.map((element) => element.id), ["one", "two"]);
    await settle();
    assert.equal(a.of("board:op").length, 0);
  });

  it("applies upserts in place and removals by id", async () => {
    const { owner, id, a, b } = await pair();
    await a.op(id, upsert(rect("x", 0), rect("y", 200)));
    await b.op(id, upsert({ ...rect("x", 50), stroke: "#ff0000" })); // replaces x without moving it in the order
    await a.op(id, remove("y"));

    const returning = await app.connect(owner);
    const joined = await returning.join(id);
    assert.deepEqual(joined.board.elements.map((element) => element.id), ["x"]);
    assert.equal(joined.board.elements[0].stroke, "#ff0000");
    assert.equal(joined.board.elements[0].x1, 50);
  });

  it("gives someone who joins late the board as it is right now, before it is saved", async () => {
    const { owner, id, a } = await pair();
    await a.op(id, upsert(rect("fresh")));
    const second = await app.connect(owner);
    const joined = await second.join(id);
    assert.deepEqual(joined.board.elements.map((element) => element.id), ["fresh"]);
  });

  it("ignores changes sent without joining, or aimed at another board", async () => {
    const { owner, id, a } = await pair();
    const otherId = await app.createBoard(owner, "Other");
    const loner = await app.connect(owner);
    assert.deepEqual(await loner.op(id, upsert(rect("no-join"))), { ok: false });
    assert.deepEqual(await a.op(otherId, upsert(rect("wrong-room"))), { ok: false });
    await settle();
    assert.equal((await Board.findById(id).lean()).elements.length, 0);
  });

  it("drops malformed elements and empty operations", async () => {
    const { id, a, b } = await pair();
    assert.deepEqual(await a.op(id, { upsert: [], remove: [] }), { ok: false });
    assert.deepEqual(await a.op(id, null), { ok: false });
    assert.deepEqual(await a.op(id, "nonsense"), { ok: false });
    assert.deepEqual(await a.op(id, upsert({ id: "x", type: "not-a-shape" }, { type: "pen" }, null, 5)), { ok: false });

    assert.deepEqual(await a.op(id, { upsert: [rect("good"), { id: "", type: "pen" }], remove: ["", 7, "gone"] }), { ok: true });
    const received = await eventually(() => b.of("board:op")[0], { message: "the sanitised operation" });
    assert.deepEqual(received.op.upsert.map((element) => element.id), ["good"]);
    assert.deepEqual(received.op.remove, ["gone"]);
  });
});

describe("saving", () => {
  it("writes the board to the database soon after a change, while people are still on it", async () => {
    const { id, a } = await pair();
    await a.op(id, upsert(rect("soon")));
    await eventually(async () => (await stored(id)).includes("soon"), { timeout: 3000, message: "the periodic save" });
  });

  it("saves a small board within 700 ms, so a crash loses very little", async () => {
    const { id, a } = await pair();
    const startedAt = Date.now();
    await a.op(id, upsert(rect("quick")));
    await eventually(async () => (await stored(id)).includes("quick"), { timeout: 700, interval: 20, message: "a quick save" });
    assert.ok(Date.now() - startedAt < 700);
  });

  it("moves the board's last-modified time forward when it saves", async () => {
    const { id, a } = await pair();
    const before = (await Board.findById(id).lean()).updatedAt;
    await settle(30);
    await a.op(id, upsert(rect("touch")));
    await eventually(async () => (await Board.findById(id).lean()).updatedAt > before, { message: "updatedAt to move" });
  });

  it("saves everything when the last person leaves", async () => {
    const { id, a, b } = await pair();
    await a.op(id, upsert(rect("a-1")));
    await b.op(id, upsert(rect("b-1")));
    a.leave();
    b.close();
    await eventually(async () => {
      const ids = await stored(id);
      return ids.includes("a-1") && ids.includes("b-1");
    }, { message: "the save on leaving" });
  });

  it("saves when someone just closes the tab", async () => {
    const { id, a, b } = await pair();
    await a.op(id, upsert(rect("abrupt")));
    a.close();
    b.close();
    await eventually(async () => (await stored(id)).includes("abrupt"), { message: "the save after disconnect" });
  });

  it("saves open boards when the server is asked to flush (shutdown)", async () => {
    const { id, a } = await pair();
    await a.op(id, upsert(rect("on-shutdown")));
    await flushAllSessions();
    assert.ok((await stored(id)).includes("on-shutdown"));
  });

  it("keeps what a board contained across everyone leaving and coming back", async () => {
    const { owner, id, a, b } = await pair();
    await a.op(id, upsert(rect("persisted")));
    a.close();
    b.close();
    await eventually(async () => (await stored(id)).includes("persisted"), { message: "save" });

    const returning = await app.connect(owner);
    const joined = await returning.join(id);
    assert.deepEqual(joined.board.elements.map((element) => element.id), ["persisted"]);
  });
});

describe("size limits", () => {
  // A pen stroke that takes roughly `bytes` to store. Real coordinates are fractional, which
  // MongoDB stores as 8-byte numbers: about 44 bytes per point.
  const stroke = (id, bytes) => ({
    id,
    type: "pen",
    points: Array.from({ length: Math.ceil(bytes / 44) }, (_, i) => [i + 0.25, i + 0.5, 0.5]),
  });

  it("measures size the way MongoDB stores it, which is bigger than the JSON", () => {
    const element = stroke("measured", 100_000);
    const stored = elementBytes(element);
    assert.ok(stored > 90_000 && stored < 115_000, `about 100 KB, got ${stored}`);
    assert.ok(stored > Buffer.byteLength(JSON.stringify(element)) * 1.5, "BSON is well over the JSON size for strokes");
  });

  async function guestOnEditableLink() {
    const owner = await app.signUp("Owner");
    const id = await app.createBoard(owner);
    await app.request(`/boards/${id}/link-access`, { method: "PATCH", user: owner, body: { linkAccess: "edit" } });
    const guest = await app.connect(null);
    await guest.join(id);
    const watcher = await app.connect(owner);
    await watcher.join(id);
    return { owner, id, guest, watcher };
  }

  it("accepts a long, ordinary freehand stroke", async () => {
    const { id, guest } = await guestOnEditableLink();
    assert.deepEqual(await guest.op(id, upsert(stroke("long", 100_000))), { ok: true });
  });

  it("rejects a single oversized element, and nobody else sees or saves it", async () => {
    const { id, guest, watcher } = await guestOnEditableLink();
    const result = await guest.op(id, upsert(rect("small"), stroke("huge", MAX_ELEMENT_BYTES + 50_000)));
    assert.deepEqual(result, { ok: false, tooLarge: true });
    await settle();
    assert.equal(watcher.of("board:op").length, 0, "the whole operation was refused, including the small element");
    assert.equal((await Board.findById(id).lean()).elements.length, 0);
  });

  it("stops a board growing past what the database can store, and keeps saving what it has", async () => {
    const { id, guest, watcher } = await guestOnEditableLink();
    const nearLimit = MAX_ELEMENT_BYTES - 10_000;
    let accepted = 0;
    let refused = null;
    for (let index = 0; index < Math.ceil(MAX_BOARD_BYTES / nearLimit) + 3; index += 1) {
      const result = await guest.op(id, upsert(stroke(`s${index}`, nearLimit)));
      if (result.ok) accepted += 1;
      else {
        refused = result;
        break;
      }
    }
    assert.deepEqual(refused, { ok: false, tooLarge: true });
    assert.ok(accepted > 10, "a good amount fits");

    // Everyone else's work still saves: nothing was left in a state the database refuses.
    await watcher.op(id, upsert(rect("still-works")));
    await eventually(async () => (await stored(id)).includes("still-works"), { timeout: 15000, message: "the later save" });
    assert.equal((await stored(id)).length, accepted + 1);
  });

  it("always lets people shrink a full board, and counts replaced elements once", async () => {
    const { id, guest } = await guestOnEditableLink();
    const nearLimit = MAX_ELEMENT_BYTES - 10_000;
    let index = 0;
    while ((await guest.op(id, upsert(stroke(`f${index}`, nearLimit)))).ok) index += 1;

    assert.equal((await guest.op(id, upsert(stroke("another", nearLimit)))).ok, false, "still full");
    assert.equal((await guest.op(id, upsert(stroke("f0", 1_000)))).ok, true, "shrinking one element in place is fine");
    assert.equal((await guest.op(id, { upsert: [], remove: ["f1", "f2"] })).ok, true, "removing is fine");
    assert.equal((await guest.op(id, upsert(stroke("another", nearLimit)))).ok, true, "there is room again");
    assert.equal((await guest.op(id, upsert(stroke("f3", nearLimit)))).ok, true, "replacing with the same size doesn't count twice");
  });

  it("keeps the same limits after a board is restored from a version", async () => {
    const { owner, id, guest } = await guestOnEditableLink();
    const nearLimit = MAX_ELEMENT_BYTES - 10_000;
    const saved = await app.request(`/boards/${id}/versions`, { method: "POST", user: owner, body: { label: "Empty" } });
    let filled = 0;
    while ((await guest.op(id, upsert(stroke(`g${filled}`, nearLimit)))).ok) filled += 1;

    await app.request(`/boards/${id}/versions/${saved.data.version.id}/restore`, { method: "POST", user: owner });
    assert.equal((await guest.op(id, upsert(stroke("after-restore", nearLimit)))).ok, true, "the restored (empty) board has room again");
  });
});

describe("moving between boards", () => {
  it("leaves the first board when joining another, so changes stop flowing", async () => {
    const owner = await app.signUp("Owner");
    const first = await app.createBoard(owner, "First");
    const second = await app.createBoard(owner, "Second");
    const mover = await app.connect(owner);
    const watcher = await app.connect(owner);
    await mover.join(first);
    await watcher.join(first);
    await mover.join(second);

    await watcher.op(first, upsert(rect("on-first")));
    await settle();
    assert.equal(mover.of("board:op").length, 0);
  });
});

describe("cursors and views", () => {
  it("relay to others on the board and never to the sender", async () => {
    const { a, b } = await pair();
    a.socket.emit("cursor", { x: 10, y: 20 });
    const cursor = await eventually(() => b.of("cursor")[0], { message: "the cursor" });
    assert.deepEqual({ x: cursor.x, y: cursor.y, socketId: cursor.socketId }, { x: 10, y: 20, socketId: a.socket.id });

    a.socket.emit("cursor", {}); // pointer left the canvas
    await eventually(() => b.of("cursor").length === 2, { message: "the hide event" });
    assert.equal(b.last("cursor").x, undefined);
    assert.equal(a.of("cursor").length, 0);
  });

  it("only pass on a view when every number is real", async () => {
    const { a, b } = await pair();
    a.socket.emit("viewport", { x: 1, y: 2, zoom: 0, width: 800, height: 600 }); // zoom must be positive
    a.socket.emit("viewport", { x: "far", y: 2, zoom: 1, width: 800, height: 600 });
    a.socket.emit("viewport", { x: 1, y: 2, zoom: 1.5, width: 800, height: 600 });
    const view = await eventually(() => b.of("viewport")[0], { message: "the valid view" });
    assert.equal(view.zoom, 1.5);
    await settle();
    assert.equal(b.of("viewport").length, 1);
  });
});

describe("operation rules", () => {
  it("replace the element with the same id and keep the order", () => {
    const base = [rect("a"), rect("b"), rect("c")];
    const next = applyOperation(base, { upsert: [{ ...rect("b"), stroke: "red" }, rect("d")], remove: ["a"] });
    assert.deepEqual(next.map((element) => element.id), ["b", "c", "d"]);
    assert.equal(next[0].stroke, "red");
  });

  it("stop growing a board past the element cap", () => {
    const full = Array.from({ length: MAX_ELEMENTS_PER_BOARD }, (_, index) => rect(`e${index}`));
    const next = applyOperation(full, { upsert: [rect("one-too-many"), { ...rect("e0"), stroke: "red" }], remove: [] });
    assert.equal(next.length, MAX_ELEMENTS_PER_BOARD);
    assert.equal(next[0].stroke, "red", "existing elements can still be edited");
    assert.equal(next.some((element) => element.id === "one-too-many"), false);
  });

  it("are rejected when there is nothing valid in them", () => {
    assert.equal(sanitizeOperation({ upsert: [{ id: "x" }], remove: [] }), null);
    assert.deepEqual(sanitizeOperation({ upsert: [rect("ok")], remove: ["a"] }), { upsert: [rect("ok")], remove: ["a"] });
    assert.equal(sanitizeOperation({ upsert: "x", remove: 5 }), null);
  });
});
