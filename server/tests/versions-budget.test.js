import assert from "node:assert/strict";
import { after, before, describe, it } from "node:test";
import { Board } from "../src/models/board.model.ts";
import { Version } from "../src/models/version.model.ts";
import { destroyBoard } from "../src/services/boards.ts";
import { recordVersion, VERSION_LIMITS } from "../src/services/versions.ts";
import { startServer } from "./helpers.js";

let app;
before(async () => {
  app = await startServer();
});
after(() => app.stop());

// Runs `fn` with some version-history limits lowered.
async function withVersionLimits(changes, fn) {
  const saved = { ...VERSION_LIMITS };
  Object.assign(VERSION_LIMITS, changes);
  try {
    return await fn();
  } finally {
    Object.assign(VERSION_LIMITS, saved);
  }
}

// A drawing of about `bytes` as MongoDB stores it.
const drawing = (bytes, id = "pen") => [
  {
    id,
    type: "pen",
    points: Array.from({ length: Math.ceil(bytes / 44) }, (_, i) => [i + 0.25, i + 0.5, 0.5]),
    pressure: false,
    stroke: "#16213a",
    penSize: 8,
  },
];

const historyBytes = async (id) =>
  (await Version.find({ board: id }).select("bytes").lean()).reduce((sum, version) => sum + version.bytes, 0);

describe("a board's version budget", () => {
  it("is never exceeded, whatever order saved versions, autosaves and restore snapshots arrive in", async () => {
    const owner = await app.signUp("Owner");
    const id = await app.createBoard(owner);
    await withVersionLimits({ bytes: 500_000 }, async () => {
      // Saved versions first, filling most of the budget while there are no autosaves to count...
      for (let index = 0; index < 4; index += 1) {
        await recordVersion(id, drawing(80_000, `n${index}`), { kind: "named", label: `n${index}` });
      }
      // ...then autosaves and a restore snapshot, which used to be kept beside them whatever the total.
      for (let index = 0; index < 10; index += 1) {
        await recordVersion(id, drawing(100_000, `a${index}`), { kind: "auto" });
        assert.ok((await historyBytes(id)) <= 500_000, `over budget after autosave ${index}`);
      }
      await recordVersion(id, drawing(100_000, "r"), { kind: "restore" });
      assert.ok((await historyBytes(id)) <= 500_000);

      const kept = await Version.find({ board: id }).sort({ createdAt: -1 }).lean();
      assert.equal(kept.filter((version) => version.kind === "named").length, 4, "saved versions are never pruned");
      assert.deepEqual(
        kept.filter((version) => version.kind !== "named").map((version) => version.elements[0].id),
        ["r"],
        "the newest is what's kept",
      );
    });
  });

  it("holds when autosaves and saved versions are written at the same moment", async () => {
    const owner = await app.signUp("Owner");
    const id = await app.createBoard(owner);
    await withVersionLimits({ bytes: 450_000 }, async () => {
      await Promise.allSettled(
        Array.from({ length: 8 }, (_, index) =>
          recordVersion(
            id,
            drawing(100_000, `v${index}`),
            index % 2 ? { kind: "auto" } : { kind: "named", label: "n" },
          ),
        ),
      );
      assert.ok((await historyBytes(id)) <= 450_000);
    });
  });

  it("refuses a restore whose before-restore copy can't fit beside the saved versions, leaving the board as it was", async () => {
    const owner = await app.signUp("Owner");
    const id = await app.createBoard(owner);
    await Board.updateOne({ _id: id }, { $set: { elements: drawing(150_000, "now") } });
    await withVersionLimits({ bytes: 300_000 }, async () => {
      const save = await app.request(`/boards/${id}/versions`, { method: "POST", user: owner, body: { label: "A" } });
      assert.equal(save.status, 201);
      await Board.updateOne({ _id: id }, { $set: { elements: drawing(200_000, "later") } });

      const restored = await app.request(`/boards/${id}/versions/${save.data.version.id}/restore`, {
        method: "POST",
        user: owner,
      });
      assert.equal(restored.status, 400);
      assert.match(restored.data.error, /undone/);
      const board = await app.request(`/boards/${id}`, { user: owner });
      assert.equal(board.data.board.elements[0].id, "later");
      assert.ok((await historyBytes(id)) <= 300_000);
    });
  });

  it("lets a board with no saved versions save one however full of autosaves its history is", async () => {
    const owner = await app.signUp("Owner");
    const id = (
      await app.request("/boards", { method: "POST", user: owner, body: { title: "Big", elements: drawing(260_000) } })
    ).data.board.id;
    await withVersionLimits({ bytes: 1_000_000 }, async () => {
      for (let index = 0; index < 3; index += 1) {
        await recordVersion(id, drawing(260_000, `a${index}`), { kind: "auto" });
      }
      // 780k of autosaves, which nobody can delete, plus this copy is over the budget: they give way.
      const save = await app.request(`/boards/${id}/versions`, {
        method: "POST",
        user: owner,
        body: { label: "mine" },
      });
      assert.equal(save.status, 201);
      assert.ok((await historyBytes(id)) <= 1_000_000);
      const autos = await Version.find({ board: id, kind: "auto" }).sort({ createdAt: -1 }).lean();
      assert.equal(autos[0]?.elements[0].id, "a2", "the newest autosave is kept when it fits");
    });
  });

  it("skips an autosave only when saved versions and the board really fill the budget, and says why a restore is refused", async () => {
    const owner = await app.signUp("Owner");
    const id = await app.createBoard(owner);
    await withVersionLimits({ bytes: 1_000_000 }, async () => {
      // Plenty of room beside three saved versions: automatic versions are never skipped.
      for (let index = 0; index < 3; index += 1) {
        await recordVersion(id, drawing(250_000, `n${index}`), { kind: "named", label: `n${index}` });
      }
      assert.ok(await recordVersion(id, drawing(200_000, "fits"), { kind: "auto" }));
      assert.ok(await recordVersion(id, drawing(200_000, "fits too"), { kind: "restore" }));
      // 750k saved, and a board of 300k: now there is genuinely no room for a copy of it.
      assert.equal(await recordVersion(id, drawing(300_000, "x"), { kind: "auto" }), null);
      await assert.rejects(
        () => recordVersion(id, drawing(300_000, "x"), { kind: "restore" }),
        (error) => error.status === 400 && /saved versions and its current drawing/.test(error.message),
      );
      assert.equal(await Version.countDocuments({ board: id, kind: "named" }), 3);
    });
  });

  it("leaves no version behind when a board is erased while one is being written", async () => {
    const owner = await app.signUp("Owner");
    const id = await app.createBoard(owner);
    await Board.updateOne({ _id: id }, { $set: { deletedAt: new Date() } });

    // Holds the write of an autosave until the erase has started.
    const create = Version.create;
    let release;
    let writing;
    const written = new Promise((resolve) => (writing = resolve));
    const gate = new Promise((resolve) => (release = resolve));
    Version.create = async (...args) => {
      writing();
      await gate;
      return create.apply(Version, args);
    };
    try {
      const saving = recordVersion(id, drawing(10_000, "late"), { kind: "auto" });
      await written;
      const erasing = destroyBoard(id);
      release();
      await Promise.all([saving, erasing]);
    } finally {
      Version.create = create;
    }
    assert.equal(await Board.exists({ _id: id }), null);
    assert.equal(await Version.countDocuments({ board: id }), 0);
  });

  it("writes no version for a board that is being erased or is gone", async () => {
    const owner = await app.signUp("Owner");
    const id = await app.createBoard(owner);
    await Board.updateOne({ _id: id }, { $set: { deletedAt: new Date(), purgingAt: new Date() } });
    assert.equal(await recordVersion(id, drawing(1_000), { kind: "auto" }), null);
    await assert.rejects(() => recordVersion(id, drawing(1_000), { kind: "named", label: "n" }), { status: 404 });
    assert.equal(await Version.countDocuments({ board: id }), 0);
  });
});
