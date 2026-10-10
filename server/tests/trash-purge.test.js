import assert from "node:assert/strict";
import { after, before, describe, it } from "node:test";
import { Board } from "../src/models/board.model.js";
import { Thread } from "../src/models/thread.model.js";
import { User } from "../src/models/user.model.js";
import { Version } from "../src/models/version.model.js";
import { destroyBoard } from "../src/services/boards.js";
import { expiredBoards, purgeExpiredTrash } from "../src/services/trash.js";
import { startServer } from "./helpers.js";

let app;
before(async () => {
  app = await startServer();
});
after(() => app.stop());

const trash = (user, id) => app.request(`/boards/${id}`, { method: "DELETE", user });
const restore = (user, id) => app.request(`/boards/${id}/restore`, { method: "POST", user });
const listTrash = async (user) => (await app.request("/boards/trash", { user })).data.boards;

// Runs `fn` with Thread.deleteMany (one of the things erasing a board deletes) replaced by `standIn`.
async function whileDeletingThreads(standIn, fn) {
  const original = Thread.deleteMany;
  Thread.deleteMany = (...args) => standIn(() => original.apply(Thread, args));
  try {
    return await fn();
  } finally {
    Thread.deleteMany = original;
  }
}

async function trashedBoard() {
  const owner = await app.signUp("Owner");
  const id = await app.createBoard(owner);
  await Version.create({ board: id, kind: "named", label: "Keep", elements: [] });
  await trash(owner, id);
  return { owner, id };
}

describe("erasing a board for good", () => {
  it("refuses a restore that arrives while the board's contents are being deleted", async () => {
    const { owner, id } = await trashedBoard();
    let restoring;
    await whileDeletingThreads(
      async (deleteThreads) => {
        restoring = await restore(owner, id);
        return deleteThreads();
      },
      () => destroyBoard(id),
    );
    assert.equal(restoring.status, 409);
    assert.match(restoring.data.error, /being deleted for good/);
    assert.equal(await Board.exists({ _id: id }), null, "the erase went ahead, rather than leaving a gutted board");
    assert.equal(await Version.countDocuments({ board: id }), 0);
  });

  it("finishes a deletion that was cut off part-way at the next sweep, and never brings the board back", async () => {
    const { owner, id } = await trashedBoard();
    await whileDeletingThreads(
      () => Promise.reject(new Error("the database hiccupped")),
      () => assert.rejects(destroyBoard(id), /hiccupped/),
    );

    assert.ok(await Board.exists({ _id: id }));
    assert.deepEqual(await listTrash(owner), [], "it's on its way out, so the trash doesn't offer it");
    assert.equal((await restore(owner, id)).status, 409);

    // Trashed just now, well inside the retention period, but already half deleted.
    assert.equal(await purgeExpiredTrash(), 1);
    assert.equal(await Board.exists({ _id: id }), null);
    assert.equal(await Version.countDocuments({ board: id }), 0);
  });
});

describe("erasing a board by hand", () => {
  it("says so when the board was restored just before the erase, rather than reporting it gone", async () => {
    const { owner, id } = await trashedBoard();
    // The owner restores it (in another tab) after the purge looked it up, before it is claimed.
    const original = Board.updateOne;
    Board.updateOne = function (filter, update, ...rest) {
      if (update?.$set?.purgingAt === undefined) return original.call(this, filter, update, ...rest);
      Board.updateOne = original;
      return original
        .call(this, { _id: id }, { $set: { deletedAt: null } })
        .then(() => original.call(this, filter, update, ...rest));
    };
    try {
      const purged = await app.request(`/boards/${id}/permanent`, { method: "DELETE", user: owner });
      assert.equal(purged.status, 409);
      assert.match(purged.data.error, /restored/);
    } finally {
      Board.updateOne = original;
    }
    assert.ok(await Board.exists({ _id: id, deletedAt: null }), "the board is still there");
    assert.equal(await Version.countDocuments({ board: id }), 1);
  });
});

describe("the trash sweep's query", () => {
  // Every stage of the winning plan, however deeply nested (an $or has one input per branch).
  const stages = (plan) => [
    plan.stage,
    ...[plan.inputStage, ...(plan.inputStages ?? [])].flatMap((p) => (p ? stages(p) : [])),
  ];

  it("is answered from indexes, so it doesn't read every board's drawing", async () => {
    await Board.init(); // the indexes are built
    const owner = await app.signUp("Owner");
    await Promise.all(Array.from({ length: 30 }, () => app.createBoard(owner)));
    const plan = await Board.find(expiredBoards(new Date())).select("_id").explain("queryPlanner");
    const used = stages(plan.queryPlanner.winningPlan);
    assert.ok(!used.includes("COLLSCAN"), `plan: ${used.join(" > ")}`);
    assert.ok(used.includes("IXSCAN"));
  });

  it("still finds both boards trashed long ago and boards being erased", async () => {
    const owner = await app.signUp("Owner");
    const old = await app.createBoard(owner);
    const half = await app.createBoard(owner);
    const fresh = await app.createBoard(owner);
    await Board.updateOne({ _id: old }, { $set: { deletedAt: new Date(Date.now() - 40 * 24 * 3600 * 1000) } });
    await Board.updateOne({ _id: half }, { $set: { deletedAt: new Date(), purgingAt: new Date() } });
    await Board.updateOne({ _id: fresh }, { $set: { deletedAt: new Date() } });
    const found = (await Board.find(expiredBoards(new Date(Date.now() - 30 * 24 * 3600 * 1000))).select("_id")).map(
      (board) => String(board._id),
    );
    assert.ok(found.includes(String(old)) && found.includes(String(half)));
    assert.ok(!found.includes(String(fresh)));
  });
});

describe("inviting someone", () => {
  it("says the board is gone, not that they already have access, when it was trashed meanwhile", async () => {
    const owner = await app.signUp("Owner");
    const invitee = await app.signUp("Invitee");
    const id = await app.createBoard(owner);

    // The owner trashes the board (in another tab) while the invite is looking the person up.
    const original = User.findOne;
    User.findOne = function (filter, ...rest) {
      if (filter?.email !== invitee.email) return original.call(this, filter, ...rest); // signing in, say
      User.findOne = original;
      return Board.updateOne({ _id: id }, { deletedAt: new Date() }).then(() => original.call(this, filter, ...rest));
    };
    try {
      const invited = await app.request(`/boards/${id}/collaborators`, {
        method: "POST",
        user: owner,
        body: { email: invitee.email },
      });
      assert.equal(invited.status, 404);
      assert.match(invited.data.error, /deleted/);
    } finally {
      User.findOne = original;
    }
  });
});
