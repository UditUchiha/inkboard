import assert from "node:assert/strict";
import { after, before, describe, it } from "node:test";
import mongoose from "mongoose";
import type { BoardReply, FullVersionReply, RestoredVersionReply, VersionReply } from "@inkboard/shared/api";
import type { Element, Point } from "@inkboard/shared/types";
import { Board } from "../src/models/board.model.ts";
import { Version } from "../src/models/version.model.ts";
import { destroyBoard, drawingBytes } from "../src/services/boards.ts";
import { compressOldVersions, recordVersion, VERSION_LIMITS, versionElements } from "../src/services/versions.ts";
import { notes, rect, startServer } from "./helpers.ts";
import type { ServerInstance } from "./helpers.ts";

let app: ServerInstance;
before(async () => {
  app = await startServer();
});
after(() => app.stop());

// Runs `fn` with some version-history limits lowered.
async function withVersionLimits(changes: Partial<typeof VERSION_LIMITS>, fn: () => Promise<unknown>) {
  const saved = { ...VERSION_LIMITS };
  Object.assign(VERSION_LIMITS, changes);
  try {
    return await fn();
  } finally {
    Object.assign(VERSION_LIMITS, saved);
  }
}

// The id of the first element a version holds.
const firstId = async (version: Parameters<typeof versionElements>[0]) => (await versionElements(version))[0]?.id;

const historyBytes = async (id: string) =>
  (await Version.find({ board: id }).select("bytes").lean()).reduce((sum, version) => sum + version.bytes!, 0);

describe("a board's version budget", () => {
  it("is never exceeded, whatever order saved versions, autosaves and restore snapshots arrive in", async () => {
    const owner = await app.signUp("Owner");
    const id = await app.createBoard(owner);
    await withVersionLimits({ bytes: 500_000 }, async () => {
      // Saved versions first, filling most of the budget while there are no autosaves to count...
      for (let index = 0; index < 4; index += 1) {
        await recordVersion(id, notes(80_000, `n${index}`), { kind: "named", label: `n${index}` });
      }
      // ...then autosaves and a restore snapshot, which used to be kept beside them whatever the total.
      for (let index = 0; index < 10; index += 1) {
        await recordVersion(id, notes(100_000, `a${index}`), { kind: "auto" });
        assert.ok((await historyBytes(id)) <= 500_000, `over budget after autosave ${index}`);
      }
      await recordVersion(id, notes(100_000, "r"), { kind: "restore" });
      assert.ok((await historyBytes(id)) <= 500_000);

      const kept = await Version.find({ board: id }).sort({ createdAt: -1 });
      assert.equal(kept.filter((version) => version.kind === "named").length, 4, "saved versions are never pruned");
      assert.deepEqual(
        await Promise.all(kept.filter((version) => version.kind !== "named").map(firstId)),
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
          recordVersion(id, notes(100_000, `v${index}`), index % 2 ? { kind: "auto" } : { kind: "named", label: "n" }),
        ),
      );
      assert.ok((await historyBytes(id)) <= 450_000);
    });
  });

  it("refuses a restore whose before-restore copy can't fit beside the saved versions, leaving the board as it was", async () => {
    const owner = await app.signUp("Owner");
    const id = await app.createBoard(owner);
    await Board.updateOne({ _id: id }, { $set: { elements: notes(150_000, "now") } });
    await withVersionLimits({ bytes: 300_000 }, async () => {
      const save = await app.request<VersionReply>(`/boards/${id}/versions`, {
        method: "POST",
        user: owner,
        body: { label: "A" },
      });
      assert.equal(save.status, 201);
      await Board.updateOne({ _id: id }, { $set: { elements: notes(200_000, "later") } });

      const restored = await app.request<{ error: string }>(`/boards/${id}/versions/${save.data.version.id}/restore`, {
        method: "POST",
        user: owner,
      });
      assert.equal(restored.status, 400);
      assert.match(restored.data.error, /undone/);
      const board = await app.request<BoardReply>(`/boards/${id}`, { user: owner });
      assert.equal(board.data.board.elements[0].id, "later");
      assert.ok((await historyBytes(id)) <= 300_000);
    });
  });

  it("lets a board with no saved versions save one however full of autosaves its history is", async () => {
    const owner = await app.signUp("Owner");
    const id = (
      await app.request<BoardReply>("/boards", {
        method: "POST",
        user: owner,
        body: { title: "Big", elements: notes(260_000) },
      })
    ).data.board.id;
    await withVersionLimits({ bytes: 1_000_000 }, async () => {
      for (let index = 0; index < 3; index += 1) {
        await recordVersion(id, notes(260_000, `a${index}`), { kind: "auto" });
      }
      // 780k of autosaves, which nobody can delete, plus this copy is over the budget: they give way.
      const save = await app.request(`/boards/${id}/versions`, {
        method: "POST",
        user: owner,
        body: { label: "mine" },
      });
      assert.equal(save.status, 201);
      assert.ok((await historyBytes(id)) <= 1_000_000);
      const autos = await Version.find({ board: id, kind: "auto" }).sort({ createdAt: -1 });
      assert.equal(await firstId(autos[0]!), "a2", "the newest autosave is kept when it fits");
    });
  });

  it("skips an autosave only when saved versions and the board really fill the budget, and says why a restore is refused", async () => {
    const owner = await app.signUp("Owner");
    const id = await app.createBoard(owner);
    await withVersionLimits({ bytes: 1_000_000 }, async () => {
      // Plenty of room beside three saved versions: automatic versions are never skipped.
      for (let index = 0; index < 3; index += 1) {
        await recordVersion(id, notes(250_000, `n${index}`), { kind: "named", label: `n${index}` });
      }
      assert.ok(await recordVersion(id, notes(200_000, "fits"), { kind: "auto" }));
      assert.ok(await recordVersion(id, notes(200_000, "fits too"), { kind: "restore" }));
      // 750k saved, and a board of 300k: now there is genuinely no room for a copy of it.
      assert.equal(await recordVersion(id, notes(300_000, "x"), { kind: "auto" }), null);
      await assert.rejects(
        () => recordVersion(id, notes(300_000, "x"), { kind: "restore" }),
        (error: unknown) =>
          (error as { status?: number; message: string }).status === 400 &&
          /saved versions and its current drawing/.test((error as { status?: number; message: string }).message),
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
    let release!: () => void;
    let writing!: () => void;
    const written = new Promise<void>((resolve) => (writing = resolve));
    const gate = new Promise<void>((resolve) => (release = resolve));
    Version.create = (async (...args: Parameters<typeof create>) => {
      writing();
      await gate;
      return (create as Function).apply(Version, args);
    }) as unknown as typeof Version.create;
    try {
      const saving = recordVersion(id, notes(10_000, "late"), { kind: "auto" });
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
    assert.equal(await recordVersion(id, notes(1_000), { kind: "auto" }), null);
    await assert.rejects(() => recordVersion(id, notes(1_000), { kind: "named", label: "n" }), { status: 404 });
    assert.equal(await Version.countDocuments({ board: id }), 0);
  });
});

describe("compressed versions", () => {
  // A board of the kinds of things people draw, which compresses as boards do.
  const board = (): Element[] => [
    ...Array.from({ length: 300 }, (_, index) => rect(`box${index}`, index * 7.25, index * 3.5)),
    {
      id: "stroke",
      type: "pen",
      points: Array.from({ length: 500 }, (_, i): Point => [
        100 + i * 1.37,
        200 + Math.round(Math.sin(i / 9) * 4000) / 100,
        0.5,
      ]),
      pressure: true,
      stroke: "#16213a",
      penSize: 4,
    },
    {
      id: "note",
      type: "sticky",
      x1: 0,
      y1: 0,
      x2: 180,
      y2: 180,
      text: "Ask about onboarding",
      fill: "#ffec99",
      font: "hand",
    },
    { id: "title", type: "text", x1: 10, y1: -60, text: "Sprint plan", stroke: "#16213a", fontSize: 28, font: "sans" },
  ];

  it("stores a version compressed, and gives back and restores exactly what was saved", async () => {
    const owner = await app.signUp("Owner");
    const id = await app.createBoard(owner);
    const elements = board();
    await Board.updateOne({ _id: id }, { $set: { elements } });
    const save = await app.request<VersionReply>(`/boards/${id}/versions`, {
      method: "POST",
      user: owner,
      body: { label: "Plan" },
    });
    assert.equal(save.status, 201);

    const stored = (await Version.findById(save.data.version.id).lean())!;
    assert.deepEqual(stored.elements, [], "the elements are only in the compressed copy");
    assert.ok(
      stored.bytes! * 4 < drawingBytes(elements),
      `${stored.bytes} bytes for a board of ${drawingBytes(elements)}`,
    );

    const shown = await app.request<FullVersionReply>(`/boards/${id}/versions/${save.data.version.id}`, {
      user: owner,
    });
    assert.deepEqual(shown.data.version.elements, elements);

    await Board.updateOne({ _id: id }, { $set: { elements: [rect("later")] } });
    const restored = await app.request<RestoredVersionReply>(`/boards/${id}/versions/${save.data.version.id}/restore`, {
      method: "POST",
      user: owner,
    });
    assert.equal(restored.status, 200);
    const now = await app.request<BoardReply>(`/boards/${id}`, { user: owner });
    assert.deepEqual(
      now.data.board.elements.map((element) => element.id),
      elements.map((element) => element.id),
    );
  });

  it("counts a history's budget by the compressed size, so it holds many more versions", async () => {
    const owner = await app.signUp("Owner");
    const id = await app.createBoard(owner);
    const elements = board();
    await withVersionLimits({ bytes: 3 * drawingBytes(elements) }, async () => {
      for (let index = 0; index < 10; index += 1) await recordVersion(id, elements, { kind: "auto" });
      // As full copies, only three would fit.
      assert.equal(await Version.countDocuments({ board: id }), 10);
      assert.ok((await historyBytes(id)) <= VERSION_LIMITS.bytes);
    });
  });

  it("reads and restores versions saved before versions were compressed, and can compress them", async () => {
    const owner = await app.signUp("Owner");
    const id = await app.createBoard(owner);
    const elements = board();
    const { insertedId } = await Version.collection.insertOne({
      board: new mongoose.Types.ObjectId(id),
      kind: "named",
      label: "Old",
      elements,
      elementCount: elements.length,
      createdAt: new Date(),
    });
    const shown = await app.request<FullVersionReply>(`/boards/${id}/versions/${insertedId}`, { user: owner });
    assert.deepEqual(shown.data.version.elements, elements);
    const restored = await app.request<RestoredVersionReply>(`/boards/${id}/versions/${insertedId}/restore`, {
      method: "POST",
      user: owner,
    });
    assert.equal(restored.data.elements.length, elements.length);

    // The one-off script (scripts/compress-versions.ts) rewrites it compressed, once.
    assert.ok((await compressOldVersions()) >= 1);
    const compressed = (await Version.findById(insertedId))!;
    assert.deepEqual(compressed.toObject().elements, []);
    assert.ok(compressed.bytes! * 4 < drawingBytes(elements));
    assert.deepEqual(await versionElements(compressed), elements);
    assert.equal(await compressOldVersions(), 0, "a second run has nothing left to do");
  });
});
