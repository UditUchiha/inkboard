import assert from "node:assert/strict";
import { after, before, describe, it } from "node:test";
import mongoose from "mongoose";
import { Board } from "../src/models/board.model.ts";
import { Version } from "../src/models/version.model.ts";
import { BOARD_LIMITS, drawingBytes, ownerBytes, roomLeft } from "../src/services/boards.js";
import { recordVersion } from "../src/services/versions.js";
import { startServer } from "./helpers.js";

let app;
before(async () => {
  app = await startServer();
});
after(() => app.stop());

// Runs `fn` with the per-owner limits lowered.
async function withBoardLimits(changes, fn) {
  const saved = { ...BOARD_LIMITS };
  Object.assign(BOARD_LIMITS, changes);
  try {
    return await fn();
  } finally {
    Object.assign(BOARD_LIMITS, saved);
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

const create = (user, body = {}) => app.request("/boards", { method: "POST", user, body });
const saveVersion = (user, id, label = "V") =>
  app.request(`/boards/${id}/versions`, { method: "POST", user, body: { label } });
const saveTemplate = (user, boardId) => app.request("/templates", { method: "POST", user, body: { boardId } });

describe("the space one person's things take", () => {
  it("counts saved versions and templates as well as boards, and checks each of them", async () => {
    const owner = await app.signUp("Owner");
    await withBoardLimits({ ownerBytes: 400_000 }, async () => {
      const id = (await create(owner, { elements: drawing(150_000) })).data.board.id;
      const version = await saveVersion(owner, id);
      assert.equal(version.status, 201); // 150k board + 150k version

      const template = await saveTemplate(owner, id); // another 150k is over 400k
      assert.equal(template.status, 400);
      assert.match(template.data.error, /used up their space/);
      const again = await saveVersion(owner, id, "Again");
      assert.equal(again.status, 400);
      assert.match(again.data.error, /used up their space/);

      await app.request(`/boards/${id}/versions/${version.data.version.id}`, { method: "DELETE", user: owner });
      assert.equal((await saveTemplate(owner, id)).status, 201, "deleting a version made room");
      assert.equal((await create(owner, { elements: drawing(150_000, "b") })).status, 400, "and templates count");
    });
  });

  it("charges a version an editor saves to the board's owner", async () => {
    const owner = await app.signUp("Owner");
    const editor = await app.signUp("Editor");
    await withBoardLimits({ ownerBytes: 250_000 }, async () => {
      const id = (await create(owner, { elements: drawing(150_000) })).data.board.id;
      await app.request(`/boards/${id}/collaborators`, { method: "POST", user: owner, body: { email: editor.email } });
      const refused = await saveVersion(editor, id);
      assert.equal(refused.status, 400);
      assert.match(refused.data.error, /owner has used up their space/);
    });
  });

  it("keeps counting a board in the trash, so restoring it takes no room", async () => {
    const owner = await app.signUp("Owner");
    await withBoardLimits({ ownerBytes: 400_000 }, async () => {
      const first = (await create(owner, { elements: drawing(150_000, "a") })).data.board.id;
      assert.equal((await create(owner, { elements: drawing(150_000, "b") })).status, 201);
      await app.request(`/boards/${first}`, { method: "DELETE", user: owner });
      assert.equal((await create(owner, { elements: drawing(150_000, "c") })).status, 400);
      assert.equal((await app.request(`/boards/${first}/restore`, { method: "POST", user: owner })).status, 200);
      assert.ok((await ownerBytes(owner.id)) <= 400_000);
    });
  });

  it("holds boards created at the same moment to the count and to the space", async () => {
    const owner = await app.signUp("Owner");
    await withBoardLimits({ perOwner: 3 }, async () => {
      const results = await Promise.all(Array.from({ length: 6 }, () => create(owner)));
      assert.equal(results.filter((result) => result.status === 201).length, 3);
    });
    const other = await app.signUp("Other");
    await withBoardLimits({ ownerBytes: 400_000 }, async () => {
      const results = await Promise.all(
        Array.from({ length: 5 }, (_, index) => create(other, { elements: drawing(150_000, `p${index}`) })),
      );
      assert.equal(results.filter((result) => result.status === 201).length, 2);
    });
  });

  it("adds up the sizes stored with each board, measuring a board saved without one once", async () => {
    const owner = await app.signUp("Owner");
    const elements = drawing(50_000);
    const created = await create(owner, { elements });
    assert.equal((await Board.findById(created.data.board.id).lean()).bytes, drawingBytes(elements));

    const { insertedId } = await Board.collection.insertOne({
      title: "Old",
      owner: new mongoose.Types.ObjectId(owner.id),
      elements: drawing(30_000, "old"),
      deletedAt: null,
    });
    const total = await ownerBytes(owner.id);
    const measured = (await Board.findById(insertedId).lean()).bytes;
    assert.equal(measured, drawingBytes(drawing(30_000, "old")), "measured the way new boards are");
    assert.equal(total, drawingBytes(elements) + measured);
  });

  it("doesn't count autosaves or before-restore copies, which nobody can delete, but does count saved versions", async () => {
    const owner = await app.signUp("Owner");
    await withBoardLimits({ ownerBytes: 400_000 }, async () => {
      const elements = drawing(50_000);
      const id = (await create(owner, { elements })).data.board.id;
      for (let index = 0; index < 30; index += 1) {
        await recordVersion(id, drawing(50_000, `a${index}`), { kind: "auto" });
      }
      await recordVersion(id, drawing(50_000, "r"), { kind: "restore" });
      assert.ok((await Version.countDocuments({ board: id })) > 10);
      assert.equal(await ownerBytes(owner.id), drawingBytes(elements), "only the board");
      assert.ok((await roomLeft(owner.id)) > 0);

      // Everything else still works, as it did not when history filled the space.
      assert.equal((await create(owner, { elements: drawing(50_000, "b") })).status, 201);
      assert.equal((await saveVersion(owner, id)).status, 201);
      assert.equal(await ownerBytes(owner.id), 2 * drawingBytes(elements) + drawingBytes(drawing(50_000, "b")));
    });
  });
});
