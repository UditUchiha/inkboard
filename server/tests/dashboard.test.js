import assert from "node:assert/strict";
import { after, before, describe, it } from "node:test";
import mongoose from "mongoose";
import { TRASH_DAYS } from "../src/controllers/board.controller.js";
import { Board } from "../src/models/board.model.js";
import { BoardState } from "../src/models/board-state.model.js";
import { purgeExpiredTrash } from "../src/services/trash.js";
import { eventually, rect, startServer, upsert } from "./helpers.js";

let app;
before(async () => {
  app = await startServer();
});
after(() => app.stop());

const list = async (user) => (await app.request("/boards", { user })).data.boards;
const find = (boards, id) => boards.find((board) => board.id === id);
const setLink = (user, id, linkAccess) => app.request(`/boards/${id}/link-access`, { method: "PATCH", user, body: { linkAccess } });
const archive = (user, ids, archived) => app.request("/boards/archive", { method: "PATCH", user, body: { ids, archived } });
const trash = (user, id) => app.request(`/boards/${id}`, { method: "DELETE", user });
const listTrash = async (user) => (await app.request("/boards/trash", { user })).data.boards;
const invite = (owner, id, person) => app.request(`/boards/${id}/collaborators`, { method: "POST", user: owner, body: { email: person.email } });

/** Opens the board over a socket, as a person looking at it would, then closes it. */
async function visit(user, boardId) {
  const client = await app.connect(user);
  const joined = await client.join(boardId);
  client.close();
  return joined;
}

describe("the board list", () => {
  it("starts empty and lists a person's own boards with default filing", async () => {
    const owner = await app.signUp("Owner");
    assert.deepEqual(await list(owner), []);
    const id = await app.createBoard(owner, "Mine");

    const [board] = await list(owner);
    assert.equal(board.id, id);
    assert.equal(board.role, "owner");
    assert.equal(board.starred, false);
    assert.equal(board.archived, false);
    assert.equal(board.lastOpenedAt, null);
  });

  it("includes boards the person was invited to, with their role", async () => {
    const owner = await app.signUp("Owner");
    const editor = await app.signUp("Editor");
    const id = await app.createBoard(owner, "Shared");
    await invite(owner, id, editor);

    const row = find(await list(editor), id);
    assert.equal(row.role, "editor");
    assert.equal(row.owner.email, owner.email, "members see the full details");
  });

  it("records when someone opens a board", async () => {
    const owner = await app.signUp("Owner");
    const id = await app.createBoard(owner);
    await visit(owner, id);
    await eventually(async () => find(await list(owner), id).lastOpenedAt, { message: "lastOpenedAt" });
  });

  it("returns the live drawing for a board that people are editing right now", async () => {
    const owner = await app.signUp("Owner");
    const id = await app.createBoard(owner);
    const client = await app.connect(owner);
    await client.join(id);
    await client.op(id, upsert(rect("live-1")));
    assert.deepEqual(find(await list(owner), id).preview.map((element) => element.id), ["live-1"]);
  });

  it("sends a preview of each drawing rather than the drawing itself", async () => {
    const owner = await app.signUp("Owner");
    const id = await app.createBoard(owner);
    const board = find(await list(owner), id);
    assert.equal(board.elements, undefined);
    assert.deepEqual(board.preview, []);
  });

  it("brings a saved board's preview up to date after each change", async () => {
    const owner = await app.signUp("Owner");
    const id = await app.createBoard(owner);
    const previewIds = async () => find(await list(owner), id).preview.map((element) => element.id);

    for (const [element, expected] of [
      ["a", ["a"]],
      ["b", ["a", "b"]],
    ]) {
      const client = await app.connect(owner);
      await client.join(id);
      await client.op(id, upsert(rect(element)));
      client.close();
      await eventually(async () => JSON.stringify(await previewIds()) === JSON.stringify(expected), {
        message: `the preview showing ${expected}`,
      });
    }
  });
});

describe("boards opened through a link", () => {
  it("appear once opened, as view-only, without emails", async () => {
    const owner = await app.signUp("Owner");
    const visitor = await app.signUp("Visitor");
    const id = await app.createBoard(owner, "Public");
    await setLink(owner, id, "view");

    assert.equal((await list(visitor)).length, 0, "an open link alone doesn't add it to anyone's list");
    assert.equal((await visit(visitor, id)).board.role, "viewer");

    await eventually(async () => find(await list(visitor), id), { message: "board on the visitor's dashboard" });
    const row = find(await list(visitor), id);
    assert.equal(row.role, "viewer");
    assert.equal(row.owner.email, undefined);
    assert.deepEqual(row.collaborators, []);
    assert.ok(row.lastOpenedAt);
  });

  it("show as editable when the link allows editing", async () => {
    const owner = await app.signUp("Owner");
    const visitor = await app.signUp("Visitor");
    const id = await app.createBoard(owner);
    await setLink(owner, id, "edit");
    await visit(visitor, id);
    await eventually(async () => find(await list(visitor), id)?.role === "contributor", { message: "contributor row" });
  });

  it("don't create entries for guests", async () => {
    const owner = await app.signUp("Owner");
    const id = await app.createBoard(owner);
    await setLink(owner, id, "view");
    const before = await BoardState.countDocuments({ board: id });
    const guest = await app.connect(null);
    assert.equal((await guest.join(id)).ok, true);
    assert.equal(await BoardState.countDocuments({ board: id }), before);
  });

  it("vanish when the owner closes the link and return when it reopens", async () => {
    const owner = await app.signUp("Owner");
    const visitor = await app.signUp("Visitor");
    const id = await app.createBoard(owner);
    await setLink(owner, id, "view");
    await visit(visitor, id);
    await eventually(async () => find(await list(visitor), id), { message: "board listed" });

    await setLink(owner, id, "restricted");
    assert.equal(find(await list(visitor), id), undefined);
    await setLink(owner, id, "view");
    assert.ok(find(await list(visitor), id), "their visit is remembered");
  });

  it("can be removed from the list by the visitor, and come back on the next visit", async () => {
    const owner = await app.signUp("Owner");
    const visitor = await app.signUp("Visitor");
    const id = await app.createBoard(owner);
    await setLink(owner, id, "view");
    await visit(visitor, id);
    await eventually(async () => find(await list(visitor), id), { message: "board listed" });

    assert.equal((await app.request(`/boards/${id}/state`, { method: "DELETE", user: visitor })).status, 204);
    assert.equal(find(await list(visitor), id), undefined);
    await visit(visitor, id);
    await eventually(async () => find(await list(visitor), id), { message: "board listed again" });
  });

  it("are dropped from the list when someone leaves a board that has an open link", async () => {
    const owner = await app.signUp("Owner");
    const person = await app.signUp("Person");
    const id = await app.createBoard(owner);
    await setLink(owner, id, "view");
    await invite(owner, id, person);
    await visit(person, id);

    assert.equal((await app.request(`/boards/${id}/collaborators/me`, { method: "DELETE", user: person })).status, 200);
    assert.equal(find(await list(person), id), undefined, "leaving shouldn't leave the board lingering as a viewer");
  });
});

describe("archive", () => {
  it("is per person and can be undone", async () => {
    const owner = await app.signUp("Owner");
    const editor = await app.signUp("Editor");
    const id = await app.createBoard(owner);
    await invite(owner, id, editor);

    assert.equal((await archive(editor, [id], true)).status, 200);
    assert.equal(find(await list(editor), id).archived, true);
    assert.equal(find(await list(owner), id).archived, false, "the owner's list is untouched");

    await archive(editor, [id], false);
    assert.equal(find(await list(editor), id).archived, false);
  });

  it("handles several boards at once and skips ones the person can't open", async () => {
    const owner = await app.signUp("Owner");
    const stranger = await app.signUp("Stranger");
    const a = await app.createBoard(owner);
    const b = await app.createBoard(owner);

    const result = await archive(owner, [a, b], true);
    assert.deepEqual(result.data.ids.sort(), [a, b].sort());

    const skipped = await archive(stranger, [a], true);
    assert.equal(skipped.status, 200);
    assert.deepEqual(skipped.data.ids, []);
    assert.deepEqual(await list(stranger), [], "no record is created for a board they can't open");
  });

  it("validates the request", async () => {
    const owner = await app.signUp("Owner");
    const id = await app.createBoard(owner);
    assert.equal((await archive(owner, [], true)).status, 400);
    assert.equal((await archive(owner, ["not-an-id"], true)).status, 400);
    assert.equal((await archive(owner, [id], "yes")).status, 400);
    assert.equal((await archive(owner, Array.from({ length: 101 }, () => new mongoose.Types.ObjectId().toString()), true)).status, 400);
    assert.equal((await app.request("/boards/archive", { method: "PATCH", body: { ids: [id], archived: true } })).status, 401);
  });
});

describe("stars", () => {
  it("are per person and for members only", async () => {
    const owner = await app.signUp("Owner");
    const editor = await app.signUp("Editor");
    const viewer = await app.signUp("Viewer");
    const id = await app.createBoard(owner);
    await invite(owner, id, editor);
    await setLink(owner, id, "view");

    const star = (user, starred) => app.request(`/boards/${id}/star`, { method: "PUT", user, body: { starred } });
    assert.equal((await star(owner, true)).status, 200);
    assert.equal(find(await list(owner), id).starred, true);
    assert.equal(find(await list(editor), id).starred, false, "someone else's star isn't yours");
    assert.equal((await star(viewer, true)).status, 403);

    await star(owner, false);
    assert.equal(find(await list(owner), id).starred, false);
  });
});

describe("trash", () => {
  it("is owner-only, hides the board from everyone, and keeps the drawing for a restore", async () => {
    const owner = await app.signUp("Owner");
    const editor = await app.signUp("Editor");
    const id = await app.createBoard(owner, "Precious");
    await invite(owner, id, editor);
    await setLink(owner, id, "view");

    const client = await app.connect(owner);
    await client.join(id);
    await client.op(id, upsert(rect("keep-me")));

    assert.equal((await trash(editor, id)).status, 403, "editors can't trash it");
    assert.equal((await trash(owner, id)).status, 204);
    await eventually(() => client.of("board:deleted").length === 1, { message: "open board closed" });

    assert.equal(find(await list(owner), id), undefined);
    assert.equal(find(await list(editor), id), undefined, "collaborators lose it too");
    assert.equal((await (await app.connect(editor)).join(id)).status, 404);
    assert.equal((await (await app.connect(null)).join(id)).status, 404);

    const row = find(await listTrash(owner), id);
    assert.ok(row.deletedAt);
    assert.deepEqual(row.preview.map((element) => element.id), ["keep-me"], "the trash shows a preview");
    assert.equal(new Date(row.purgeAt) - new Date(row.deletedAt), TRASH_DAYS * 24 * 3600 * 1000);
    assert.deepEqual((await app.request("/boards/trash", { user: editor })).data.boards, [], "only the owner has a trash for it");

    const restored = await app.request(`/boards/${id}/restore`, { method: "POST", user: owner });
    assert.equal(restored.status, 200);
    const back = find(await list(owner), id);
    assert.deepEqual(back.preview.map((element) => element.id), ["keep-me"], "the latest drawing came back");
    assert.ok(find(await list(editor), id), "and the editor has it again");
  });

  it("only restores or erases boards that are actually in the trash", async () => {
    const owner = await app.signUp("Owner");
    const other = await app.signUp("Other");
    const id = await app.createBoard(owner);

    assert.equal((await app.request(`/boards/${id}/restore`, { method: "POST", user: owner })).status, 404);
    assert.equal((await app.request(`/boards/${id}/permanent`, { method: "DELETE", user: owner })).status, 404);
    await trash(owner, id);
    assert.equal((await app.request(`/boards/${id}/permanent`, { method: "DELETE", user: other })).status, 404);
    assert.equal((await app.request(`/boards/${id}/restore`, { method: "POST", user: other })).status, 404);
  });

  it("can be erased board by board, or all at once, and takes per-person records with it", async () => {
    const owner = await app.signUp("Owner");
    const a = await app.createBoard(owner);
    const b = await app.createBoard(owner);
    const c = await app.createBoard(owner);
    await visit(owner, a);
    await eventually(() => BoardState.exists({ board: a }), { message: "BoardState for a" });

    await trash(owner, a);
    await trash(owner, b);
    await trash(owner, c);
    assert.equal((await app.request(`/boards/${a}/permanent`, { method: "DELETE", user: owner })).status, 204);
    assert.equal(await Board.exists({ _id: a }), null);
    assert.equal(await BoardState.exists({ board: a }), null, "no records left behind");

    assert.equal((await app.request("/boards/trash", { method: "DELETE", user: owner })).status, 204);
    assert.deepEqual((await app.request("/boards/trash", { user: owner })).data.boards, []);
    assert.equal(await Board.exists({ _id: b }), null);
  });

  it("is swept after the retention period, and not before", async () => {
    const owner = await app.signUp("Owner");
    const fresh = await app.createBoard(owner);
    const expired = await app.createBoard(owner);
    await trash(owner, fresh);
    await trash(owner, expired);
    const longAgo = new Date(Date.now() - (TRASH_DAYS + 1) * 24 * 3600 * 1000);
    await Board.updateOne({ _id: expired }, { deletedAt: longAgo });

    assert.equal(await purgeExpiredTrash(), 1);
    assert.equal(await Board.exists({ _id: expired }), null);
    assert.ok(await Board.exists({ _id: fresh }));
  });
});

describe("renaming", () => {
  it("is allowed for members and refused for viewers", async () => {
    const owner = await app.signUp("Owner");
    const viewer = await app.signUp("Viewer");
    const id = await app.createBoard(owner, "Before");
    await setLink(owner, id, "view");

    const rename = (user, title) => app.request(`/boards/${id}`, { method: "PATCH", user, body: { title } });
    assert.equal((await rename(viewer, "Hacked")).status, 403);
    assert.equal((await rename(owner, "")).status, 400);
    assert.equal((await rename(owner, "x".repeat(81))).status, 400);
    const ok = await rename(owner, "After");
    assert.equal(ok.status, 200);
    assert.equal(find(await list(owner), id).title, "After");
  });
});
