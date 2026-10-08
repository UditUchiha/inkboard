import assert from "node:assert/strict";
import { after, before, describe, it } from "node:test";
import { applyOperation, groupStamps, withStamps } from "@inkboard/shared/board-merge";
import { Board } from "../src/models/board.model.js";
import {
  elementBytes,
  MAX_BOARD_BYTES,
  MAX_ELEMENT_BYTES,
  MAX_ELEMENTS_PER_BOARD,
  prepareOperation,
  RESTORE_LEAD,
  sanitizeOperation,
  SYNC_FORMAT,
} from "../src/realtime/operations.js";
import { readRemoved, REMOVED_LIMITS } from "../src/realtime/sessions.js";
import { flushAllSessions } from "../src/realtime/index.js";
import { eventually, rect, remove, settle, startServer, upsert } from "./helpers.js";

let app;
before(async () => {
  app = await startServer();
});
after(() => app.stop());

const stored = async (boardId) => (await Board.findById(boardId).lean()).elements.map((element) => element.id);
const invite = (owner, id, person) => app.request(`/boards/${id}/collaborators`, { method: "POST", user: owner, body: { email: person.email } });

/** An owner and one invited editor, both on a fresh board (on an older app unless `sync` says otherwise). */
async function pair({ sync } = {}) {
  const owner = await app.signUp("Owner");
  const editor = await app.signUp("Editor");
  const id = await app.createBoard(owner);
  await invite(owner, id, editor);
  const a = await app.connect(owner);
  const b = await app.connect(editor);
  await a.join(id, { sync });
  await b.join(id, { sync });
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
    // A plain id (from an older browser) is stamped as the newest removal.
    assert.deepEqual(received.op.remove.map((removal) => removal.id), ["gone"]);
    assert.equal(received.op.remove[0].version, 1);
  });
});

describe("changes that cross", () => {
  const at = (version, versionNonce, extra = {}) => ({ ...rect("x"), index: "a0", version, versionNonce, ...extra });
  // `element` with the groups in `changed` stamped as a newer edit, as the current app sends it.
  const edit = (element, changed, stamp, fields) =>
    withStamps({ ...element, ...fields }, { ...groupStamps(element), ...Object.fromEntries(changed.map((group) => [group, stamp])) });

  it("keep both a move and a recolor made at the same time, and everyone ends up with both", async () => {
    const { id, a, b } = await pair({ sync: SYNC_FORMAT });
    const start = at(1, 0);
    await a.op(id, upsert(start));
    await eventually(() => b.of("board:op").length === 1, { message: "the shape reaching b" });

    const moved = edit(start, ["shape"], { version: 2, versionNonce: 5 }, { x1: 500, x2: 600 });
    const recolored = edit(start, ["stroke"], { version: 2, versionNonce: 9 }, { stroke: "#e03131" });
    const [fromA, fromB] = await Promise.all([a.op(id, upsert(moved)), b.op(id, upsert(recolored))]);
    assert.equal(fromA.ok && fromB.ok, true);
    await flushAllSessions();
    const [saved] = (await Board.findById(id).lean()).elements;
    assert.deepEqual([saved.x1, saved.x2, saved.stroke], [500, 600, "#e03131"]);

    // Each screen: its own change, plus what it was sent.
    await eventually(() => a.of("board:op").length === 1 || b.of("board:op").length === 2, { message: "the second change passed on" });
    await settle();
    const screen = (own, client) => client.of("board:op").reduce((board, { op }) => applyOperation(board, op), applyOperation([start], upsert(own)));
    assert.deepEqual(screen(moved, a), [saved]);
    assert.deepEqual(screen(recolored, b), [saved]);
  });

  it("pass on a change to a removed element, so whoever brings it back brings back the same thing", async () => {
    const { id, a, b } = await pair({ sync: SYNC_FORMAT });
    const start = at(1, 0);
    await a.op(id, upsert(start));
    await a.op(id, { upsert: [], remove: [{ id: "x", version: 3, versionNonce: 0 }] });
    await eventually(() => b.of("board:op").length === 2, { message: "the removal reaching b" });

    const late = edit(start, ["stroke"], { version: 2, versionNonce: 1 }, { stroke: "#2f9e44" });
    assert.equal((await b.op(id, upsert(late))).ok, true, "a color picked before the removal arrived");
    await eventually(() => a.of("board:op").length === 1, { message: "the late color reaching a" });
    assert.equal(a.last("board:op").op.upsert[0].stroke, "#2f9e44");
    await flushAllSessions();
    assert.deepEqual((await Board.findById(id).lean()).elements, [], "it stays removed");
  });

  it("settle on the same winner for everyone, whichever reaches the server first", async () => {
    const { id, a, b } = await pair();
    await a.op(id, upsert(at(1, 0)));
    await eventually(() => b.of("board:op").length === 1, { message: "the shape reaching b" });

    // Both change the shape from version 1 at the same moment; the lower nonce wins.
    const [fromA, fromB] = await Promise.all([a.op(id, upsert(at(2, 5, { stroke: "#e03131" }))), b.op(id, upsert(at(2, 9, { x1: 500 })))]);
    assert.equal(fromA.ok && fromB.ok, true);
    await flushAllSessions();
    const saved = (await Board.findById(id).lean()).elements;
    assert.deepEqual(saved, [at(2, 5, { stroke: "#e03131" })]);

    // b must have been sent a's change; a's own change needs nothing from b.
    await eventually(() => b.of("board:op").some((message) => message.op.upsert[0]?.versionNonce === 5), { message: "a's change reaching b" });
    assert.ok(!a.of("board:op").some((message) => message.op.upsert[0]?.versionNonce === 9), "b's losing change isn't passed on");
  });

  it("keep a removal over an older edit that arrives after it, and let a newer edit bring the element back", async () => {
    const { id, a, b } = await pair();
    await a.op(id, upsert(at(1, 0)));
    assert.equal((await a.op(id, { upsert: [], remove: [{ id: "x", version: 2, versionNonce: 1 }] })).ok, true);
    assert.equal((await b.op(id, upsert(at(2, 7, { x1: 300 })))).ok, true, "an edit made before seeing the removal");
    await flushAllSessions();
    assert.deepEqual((await Board.findById(id).lean()).elements, [], "the late, older edit doesn't bring it back");

    assert.equal((await b.op(id, upsert(at(3, 4)))).ok, true, "a newer edit (an undo, say)");
    await flushAllSessions();
    assert.deepEqual((await Board.findById(id).lean()).elements, [at(3, 4)]);
  });

  it("still take changes from browsers running the older app, as the newest edit", async () => {
    const { id, a } = await pair();
    await a.op(id, upsert(at(5, 0)));
    await a.op(id, upsert(rect("x")));
    await flushAllSessions();
    const [saved] = (await Board.findById(id).lean()).elements;
    assert.equal(saved.version, 6);
  });
});

describe("stacking order", () => {
  it("gives a board saved before elements had places in the stack places, in the order it was saved", async () => {
    const owner = await app.signUp("Owner");
    const { data } = await app.request("/boards", { method: "POST", user: owner, body: { elements: [rect("c"), rect("a"), rect("b")] } });
    const joined = await (await app.connect(owner)).join(data.board.id, { sync: SYNC_FORMAT });
    const { elements } = joined.board;
    assert.deepEqual(elements.map((element) => element.id), ["c", "a", "b"]);
    const keys = elements.map((element) => element.index);
    assert.deepEqual([...keys].sort(), keys);
  });

  it("puts a new element from a browser on an older app on top", async () => {
    const { id, a } = await pair();
    await a.op(id, upsert(rect("first"), rect("second")));
    await a.op(id, upsert(rect("third")));
    await flushAllSessions();
    assert.deepEqual(await stored(id), ["first", "second", "third"]);
  });
});

describe("removals that outlast the board being open", () => {
  const at = (version, versionNonce, extra = {}) => ({ ...rect("x"), index: "a0", version, versionNonce, ...extra });

  it("keep an edit made before a removal out, even when it arrives after everyone left", async () => {
    const { editor, id, a, b } = await pair({ sync: SYNC_FORMAT });
    await a.op(id, upsert(at(1, 0)));
    await a.op(id, { upsert: [], remove: [{ id: "x", version: 3, versionNonce: 0 }] });
    a.close();
    b.close();
    await eventually(async () => (await Board.findById(id).select("+removed").lean()).removed.length === 1, { message: "the removal saved" });

    // Someone who was offline the whole time comes back with an edit they made before it.
    const back = await app.connect(editor);
    await back.join(id, { sync: SYNC_FORMAT });
    assert.equal((await back.op(id, upsert(at(2, 0, { x1: 300 })))).ok, true);
    await flushAllSessions();
    assert.deepEqual(await stored(id), [], "it stays removed");

    assert.equal((await back.op(id, upsert(at(4, 0)))).ok, true, "a newer edit (an undo) still brings it back");
    await flushAllSessions();
    assert.deepEqual(await stored(id), ["x"]);
  });

  it("are forgotten after a while, and past a number", () => {
    const now = Date.now();
    const old = { id: "old", version: 1, versionNonce: 0, at: now - REMOVED_LIMITS.ageMs - 1000 };
    const live = { id: "on-board", version: 1, versionNonce: 0, at: now };
    const broken = { id: "broken", version: -1, versionNonce: 0, at: now };
    const many = Array.from({ length: REMOVED_LIMITS.count + 5 }, (_, n) => ({ id: `r${n}`, version: 2, versionNonce: 1, at: now - 1000 + n }));
    const { tombstones, removedAt } = readRemoved([old, live, broken, ...many], [rect("on-board")]);
    assert.equal(tombstones.size, REMOVED_LIMITS.count);
    assert.equal(tombstones.has("r0"), false, "the oldest go first");
    assert.equal(tombstones.has(`r${REMOVED_LIMITS.count + 4}`), true);
    for (const id of ["old", "on-board", "broken"]) assert.equal(removedAt.has(id), false, id);
  });
});

describe("restoring a version", () => {
  it("wins over edits made before it that arrive after it", async () => {
    const { owner, id, a } = await pair({ sync: SYNC_FORMAT });
    await a.op(id, upsert({ ...rect("kept"), index: "a0", version: 1, versionNonce: 0 }));
    await flushAllSessions();
    const saved = await app.request(`/boards/${id}/versions`, { method: "POST", user: owner, body: { label: "Start" } });
    await a.op(id, upsert({ ...rect("added"), index: "a1", version: 1, versionNonce: 0 }));

    const restored = await app.request(`/boards/${id}/versions/${saved.data.version.id}/restore`, { method: "POST", user: owner });
    assert.deepEqual(restored.data.elements.map((element) => element.id), ["kept"]);
    assert.ok(restored.data.elements[0].version >= RESTORE_LEAD, "stamped well ahead");

    // Edits from before the restore, still on their way.
    await a.op(id, upsert({ ...rect("kept", 999), index: "a0", version: 40, versionNonce: 0 }));
    await a.op(id, upsert({ ...rect("added", 999), index: "a1", version: 40, versionNonce: 0 }));
    await flushAllSessions();
    const [kept, ...rest] = (await Board.findById(id).lean()).elements;
    assert.equal(kept.x1, 0);
    assert.deepEqual(rest, [], "what the restore removed stays removed");
  });

  it("works the same on a board nobody has open", async () => {
    const owner = await app.signUp("Owner");
    const id = await app.createBoard(owner);
    const a = await app.connect(owner);
    await a.join(id, { sync: SYNC_FORMAT });
    await a.op(id, upsert({ ...rect("kept"), index: "a0", version: 1, versionNonce: 0 }));
    await flushAllSessions();
    const saved = await app.request(`/boards/${id}/versions`, { method: "POST", user: owner, body: { label: "Start" } });
    await a.op(id, upsert({ ...rect("added"), index: "a1", version: 1, versionNonce: 0 }));
    a.close();
    await eventually(async () => (await stored(id)).length === 2, { message: "the board saved as everyone left" });

    await app.request(`/boards/${id}/versions/${saved.data.version.id}/restore`, { method: "POST", user: owner });
    const board = await Board.findById(id).select("+removed").lean();
    assert.deepEqual(board.elements.map((element) => element.id), ["kept"]);
    assert.ok(board.elements[0].version >= RESTORE_LEAD);
    assert.deepEqual(board.removed.map((entry) => entry.id), ["added"]);
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
  const prepare = (elements, op, tombstones = new Map(), options = {}) => prepareOperation(elements, op, tombstones, options);
  const board = [{ ...rect("a"), index: "a0", version: 4, versionNonce: 0 }, { ...rect("b"), index: "a1", version: 2, versionNonce: 0 }];

  it("stamp a change from a browser on an older app without versions as the newest edit, whole", () => {
    const [element] = prepare(board, upsert({ ...rect("a"), stroke: "#e03131" }), new Map(), { legacy: true }).upsert;
    assert.equal(element.version, 5);
    assert.equal("stamps" in element, false, "every group gets the new stamp");
    assert.equal(element.index, "a0", "and it stays where it was in the stack");
  });

  it("take a change from the previous app at its version, as a whole, ignoring stamps it copied along", () => {
    const sent = { ...board[0], x1: 9, version: 7, versionNonce: 3, stamps: { stroke: [1, 1] } };
    const [element] = prepare(board, upsert(sent), new Map(), { legacy: true }).upsert;
    assert.deepEqual([element.version, element.versionNonce, "stamps" in element], [7, 3, false]);
  });

  it("put a new element without a place in the stack on top, and one coming back where it was", () => {
    const tombstones = new Map([["gone", { version: 3, versionNonce: 0, element: { ...rect("gone"), index: "Zz" } }]]);
    const {
      upsert: [fresh, back],
    } = prepare(board, upsert(rect("new"), rect("gone")), tombstones, { legacy: true });
    assert.ok(fresh.index > "a1");
    assert.equal(back.index, "Zz");
  });

  it("stamp removals without one as the newest edit", () => {
    assert.deepEqual(prepare(board, sanitizeOperation(remove("b"))).remove.map((removal) => removal.version), [3]);
  });

  it("stop growing a board past the element cap", () => {
    const full = Array.from({ length: MAX_ELEMENTS_PER_BOARD }, (_, index) => ({ ...rect(`e${index}`), version: 1 }));
    const next = applyOperation(
      full,
      { upsert: [{ ...rect("one-too-many"), version: 1 }, { ...rect("e0"), stroke: "#e03131", version: 2 }], remove: [] },
      new Map(),
      { limit: MAX_ELEMENTS_PER_BOARD },
    );
    assert.equal(next.length, MAX_ELEMENTS_PER_BOARD);
    assert.equal(next.find((element) => element.id === "e0").stroke, "#e03131", "existing elements can still be edited");
    assert.equal(next.some((element) => element.id === "one-too-many"), false);
  });

  it("are rejected when there is nothing valid in them", () => {
    assert.equal(sanitizeOperation({ upsert: [{ id: "x" }], remove: [] }), null);
    assert.deepEqual(sanitizeOperation({ upsert: [rect("ok")], remove: ["a"] }), { upsert: [rect("ok")], remove: [{ id: "a" }] });
    assert.deepEqual(
      sanitizeOperation({ upsert: [], remove: [{ id: "b", version: 3, versionNonce: 9, extra: 1 }, { id: "c", version: -1 }] }).remove,
      [{ id: "b", version: 3, versionNonce: 9 }, { id: "c" }],
    );
    assert.equal(sanitizeOperation({ upsert: "x", remove: 5 }), null);
  });
});
