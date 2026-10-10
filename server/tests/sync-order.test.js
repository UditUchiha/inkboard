import { eventually, rect, remove, roundTrip, startServer, upsert } from "./helpers.js"; // first: it sets up the environment
import assert from "node:assert/strict";
import { after, before, describe, it } from "node:test";
import { applyOperation } from "@inkboard/shared/board-merge";
import mongoose from "mongoose";
import { Board } from "../src/models/board.model.js";
import { heldGroupBytes } from "../src/realtime/index.js";
import {
  holdPiece,
  isOversized,
  MAX_ELEMENTS_PER_BOARD,
  restoreOver,
  SYNC_FORMAT,
} from "../src/realtime/operations.js";
import { flushAllSessions } from "../src/realtime/index.js";
import { BOARD_LIMITS } from "../src/services/boards.js";

let app;
before(async () => {
  app = await startServer();
});
after(() => app.stop());

const invite = (owner, id, person) =>
  app.request(`/boards/${id}/collaborators`, { method: "POST", user: owner, body: { email: person.email } });
const piece = (client, boardId, op, group) =>
  new Promise((resolve) => client.socket.emit("board:op", { boardId, op, group }, resolve));
const stamped = (element, version = 1) => ({ ...element, index: "a0", version, versionNonce: 0 });

// An arrow as boards saved it before every line and arrow had a label, a route and arrowheads.
const oldArrow = (version = 3) => ({ ...rect("arrow"), type: "arrow", index: "a0", version, versionNonce: 7 });

describe("joining and leaving in quick succession", () => {
  it("leaves the socket in the last board it joined only, and nothing of the first reaches it", async () => {
    const owner = await app.signUp("Owner");
    const first = await app.createBoard(owner, "First");
    const second = await app.createBoard(owner, "Second");
    const watcher = await app.connect(owner);
    await watcher.join(first);
    for (let round = 0; round < 5; round += 1) {
      const mover = await app.connect(owner);
      // Not waiting for the first join: it reads the database, and the leave and the next join come meanwhile.
      mover.socket.emit("board:join", { boardId: first, sync: SYNC_FORMAT });
      mover.socket.emit("board:leave");
      assert.equal((await mover.join(second, { sync: SYNC_FORMAT })).ok, true);

      await watcher.op(first, upsert(rect(`on-first-${round}`)));
      await roundTrip(mover);
      assert.equal(mover.of("board:op").length, 0, `round ${round}: the first board's changes don't reach it`);
      const presence = await eventually(
        () => watcher.of("presence").at(-1)?.length === 1 && watcher.of("presence").at(-1),
        { message: "the first board's presence without the mover" },
      );
      assert.deepEqual(
        presence.map((person) => person.socketId),
        [watcher.socket.id],
      );
      mover.close();
    }
  });

  it("says which board each event is about", async () => {
    const owner = await app.signUp("Owner");
    const editor = await app.signUp("Editor");
    const id = await app.createBoard(owner);
    await invite(owner, id, editor);
    const a = await app.connect(owner);
    const b = await app.connect(editor);
    await a.join(id, { sync: SYNC_FORMAT });
    await b.join(id, { sync: SYNC_FORMAT });
    await a.op(id, upsert(stamped(rect("r"))));
    const op = await eventually(() => b.of("board:op")[0], { message: "the change" });
    assert.equal(op.boardId, id);
    // Presence keeps the list first, as older apps read it, with the board after it.
    const presence = [];
    b.socket.on("presence", (list, about) => presence.push({ list, about }));
    a.leave();
    const after = await eventually(() => presence[0], { message: "presence" });
    assert.ok(Array.isArray(after.list));
    assert.deepEqual(after.about, { boardId: id });
  });
});

describe("limits on an operation", () => {
  it("refuses more removals than a board can hold even without any upserts", async () => {
    const ids = Array.from({ length: MAX_ELEMENTS_PER_BOARD + 1 }, (_, n) => `x${n}`);
    assert.equal(isOversized({ remove: ids }), true);
    assert.equal(isOversized({ upsert: ids.map((id) => rect(id)) }), true);
    assert.equal(isOversized({ remove: ids.slice(1) }), false);
    const owner = await app.signUp("Owner");
    const id = await app.createBoard(owner);
    const a = await app.connect(owner);
    await a.join(id, { sync: SYNC_FORMAT });
    assert.equal((await a.op(id, { remove: ids })).reason, "tooLarge");
  });
});

describe("a change sent in pieces that isn't finished", () => {
  it("tells a late piece of a group the server stopped waiting for to send it all again", () => {
    const op = { upsert: [rect("a")], remove: [] };
    assert.equal(holdPiece({ id: "g", expired: true }, { id: "g", index: 1, total: 2 }, op).error, "expired");
    assert.equal(holdPiece({ id: "g", expired: true }, { id: "other", index: 1, total: 2 }, op).error, "invalid");
    assert.ok(holdPiece({ id: "g", expired: true }, { id: "g2", index: 0, total: 2 }, op).held, "a new group starts");
  });

  it("lets go of what a connection held when it leaves the board or disconnects", async () => {
    const owner = await app.signUp("Owner");
    const id = await app.createBoard(owner);
    const a = await app.connect(owner);
    await a.join(id, { sync: SYNC_FORMAT });
    const before = heldGroupBytes();
    await piece(a, id, upsert(rect("p1")), { id: "g", index: 0, total: 2 });
    assert.ok(heldGroupBytes() > before);
    a.leave();
    await a.join(id, { sync: SYNC_FORMAT });
    assert.equal(heldGroupBytes(), before);
    await piece(a, id, upsert(rect("p1")), { id: "g", index: 0, total: 2 });
    a.close();
    await eventually(() => heldGroupBytes() === before, { message: "the group let go" });
  });
});

describe("lines and arrows saved before they had every field", () => {
  it("get the defaults when the board opens, so undoing a label back to none reaches everyone", async () => {
    const owner = await app.signUp("Owner");
    const editor = await app.signUp("Editor");
    const id = await app.createBoard(owner);
    await invite(owner, id, editor);
    await Board.collection.updateOne({ _id: new mongoose.Types.ObjectId(id) }, { $set: { elements: [oldArrow()] } });
    const a = await app.connect(owner);
    const b = await app.connect(editor);
    const joined = await a.join(id, { sync: SYNC_FORMAT });
    await b.join(id, { sync: SYNC_FORMAT });
    const [arrow] = joined.board.elements;
    assert.deepEqual([arrow.text, arrow.route, arrow.startHead], ["", "straight", false]);

    // A label, then the label taken away again, as an undo sends it.
    await a.op(id, upsert({ ...arrow, text: "yes", version: 4, versionNonce: 1, stamps: undefined }));
    const labelled = { ...arrow, text: "yes", version: 4, versionNonce: 1 };
    delete labelled.stamps;
    await a.op(id, upsert({ ...labelled, text: "", version: 5 }));
    await flushAllSessions();
    const [saved] = (await Board.findById(id).lean()).elements;
    assert.equal(saved.text, "");
  });

  it("keep a restored version's empty label against a label from before the restore", () => {
    const { elements } = restoreOver([oldArrow(3)], new Map(), [oldArrow(3)]);
    assert.equal(elements[0].text, "");
    const late = { ...oldArrow(4), text: "yes", font: "hand", route: "straight", startHead: false };
    const [after] = applyOperation(elements, upsert(late));
    assert.equal(after.text, "", "the label from before the restore loses to it");
  });
});

describe("space used", () => {
  it("records a board's size as it's saved", async () => {
    const owner = await app.signUp("Owner");
    const id = await app.createBoard(owner);
    const a = await app.connect(owner);
    await a.join(id, { sync: SYNC_FORMAT });
    await a.op(id, upsert(stamped(rect("r"))));
    await flushAllSessions();
    const board = await Board.findById(id).lean();
    assert.equal(board.bytes, mongoose.mongo.BSON.calculateObjectSize({ elements: board.elements }));
  });

  it("refuses drawing that would take the owner past their space, but not changes that shrink a board", async () => {
    const owner = await app.signUp("Owner");
    const id = await app.createBoard(owner);
    const a = await app.connect(owner);
    await a.join(id, { sync: SYNC_FORMAT });
    await a.op(id, upsert(stamped(rect("first"))));
    await flushAllSessions();
    const saved = { ...BOARD_LIMITS };
    try {
      const used = (await Board.findById(id).lean()).bytes;
      Object.assign(BOARD_LIMITS, { ownerBytes: used + 50_000 });
      const stroke = (n) => ({
        id: `s${n}`,
        type: "pen",
        points: Array.from({ length: 2000 }, (_, i) => [i, i, 0.5]),
        pressure: false,
        stroke: "#16213a",
        penSize: 8,
      });
      // The space left is looked up when the board is opened, and again every so often: open it again.
      a.leave();
      await a.join(id, { sync: SYNC_FORMAT });
      let n = 0;
      const refused = await eventually(
        async () => {
          n += 1;
          const reply = await a.op(id, upsert(stroke(n)));
          return reply.reason === "ownerFull" && reply;
        },
        { message: "a change past the owner's space refused" },
      );
      assert.equal(refused.ok, false);
      assert.equal((await a.op(id, remove("first"))).ok, true, "making the board smaller is always allowed");
    } finally {
      Object.assign(BOARD_LIMITS, saved);
    }
  });
});

describe("one board, however its id is spelled", () => {
  it("shares one session and one room between sockets that spell the id differently", async () => {
    const owner = await app.signUp("Owner");
    const editor = await app.signUp("Editor");
    const id = await app.createBoard(owner);
    await invite(owner, id, editor);
    const upper = id.toUpperCase();
    const a = await app.connect(owner);
    const b = await app.connect(editor);
    assert.equal((await a.join(id, { sync: SYNC_FORMAT })).board.id, id);
    const joined = await b.join(upper, { sync: SYNC_FORMAT });
    assert.equal(joined.ok, true);
    assert.equal(joined.board.id, id, "it's told the board's own id");

    // Each sees the other's work at once, and their presence lists them both.
    assert.equal((await a.op(id, upsert(stamped(rect("from-a"))))).ok, true);
    assert.equal((await b.op(upper, upsert(stamped(rect("from-b"))))).ok, true);
    const seen = await eventually(() => b.of("board:op").length > 0 && a.of("board:op").length > 0, {
      message: "both changes passed on",
    });
    assert.equal(seen, true);
    assert.equal(a.of("board:op")[0].boardId, id);
    assert.equal(b.of("board:op")[0].boardId, id);
    const presence = await eventually(() => a.of("presence").at(-1)?.length === 2 && a.of("presence").at(-1), {
      message: "presence with both",
    });
    assert.equal(presence.length, 2);

    // One session: what each drew is on the board, whoever saves last.
    await flushAllSessions();
    const saved = await Board.findById(id).lean();
    assert.deepEqual(saved.elements.map((element) => element.id).sort(), ["from-a", "from-b"]);

    // And they get what the board's id says happens to it: they're sent away together.
    await app.request(`/boards/${id}/collaborators/${editor.id}`, { method: "DELETE", user: owner });
    const revoked = await eventually(() => b.of("board:revoked")[0], { message: "revocation for the upper case one" });
    assert.equal(revoked.boardId, id);
    assert.equal((await b.op(upper, upsert(rect("late")))).ok, false);
  });
});

describe("what's left of the owner's space", () => {
  const stroke = (n) => ({
    id: `s${n}`,
    type: "pen",
    points: Array.from({ length: 2000 }, (_, i) => [i, i, 0.5]),
    pressure: false,
    stroke: "#16213a",
    penSize: 8,
  });

  it("is known by the first change, shared by an owner's open boards, and checked again before a refusal", async () => {
    const owner = await app.signUp("Owner");
    const first = await app.createBoard(owner, "First");
    const second = await app.createBoard(owner, "Second");
    const saved = { ...BOARD_LIMITS };
    try {
      const a = await app.connect(owner);
      await a.join(first, { sync: SYNC_FORMAT });
      await a.op(first, upsert(stamped(rect("one"))));
      await flushAllSessions();
      a.leave();
      const used = (await Board.find({ owner: owner.id }).lean()).reduce((sum, board) => sum + board.bytes, 0);
      Object.assign(BOARD_LIMITS, { ownerBytes: used + 150_000 });

      // The space left is known when joining, so the very first change is held to it. (Old browsers get
      // `tooLarge` too: they stop at it, where they'd send the change again every moment for good.)
      await a.join(first, { sync: SYNC_FORMAT });
      await a.join(second, { sync: SYNC_FORMAT }); // (leaves the first: it must not matter)
      const b = await app.connect(owner);
      await b.join(first, { sync: SYNC_FORMAT });
      let n = 0;
      let reply;
      do {
        n += 1;
        reply = await a.op(second, upsert(stroke(n)));
      } while (reply.ok && n < 20);
      assert.equal(reply.reason, "ownerFull");
      assert.equal(reply.tooLarge, true);
      assert.ok(n > 1, "some fit first"); // (a stroke here is about 70 KB)
      // The other board has the same owner, so it has no more room either.
      assert.equal((await b.op(first, upsert(stroke(100)))).reason, "ownerFull");

      // The owner makes room. A figure a few seconds old is looked up again before a change is refused.
      Object.assign(BOARD_LIMITS, { ownerBytes: used + 50_000_000 });
      await new Promise((resolve) => setTimeout(resolve, 3200));
      assert.equal((await b.op(first, upsert(stroke(101)))).ok, true);
    } finally {
      Object.assign(BOARD_LIMITS, saved);
    }
  });
});

describe("following", () => {
  it("passes on whose own view a view is", async () => {
    const owner = await app.signUp("Owner");
    const editor = await app.signUp("Editor");
    const id = await app.createBoard(owner);
    await invite(owner, id, editor);
    const a = await app.connect(owner);
    const b = await app.connect(editor);
    await a.join(id);
    await b.join(id);
    const view = { x: 1, y: 2, zoom: 1, width: 800, height: 600 };
    a.socket.emit("viewport", view);
    const own = await eventually(() => b.of("viewport")[0], { message: "a's own view" });
    assert.deepEqual([own.source, own.boardId], [a.socket.id, id]);
    a.socket.emit("viewport", { ...view, source: "someone-else" });
    const taken = await eventually(() => b.of("viewport")[1], { message: "a view a took from someone" });
    assert.equal(taken.source, "someone-else");
  });
});
