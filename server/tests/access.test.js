import assert from "node:assert/strict";
import { after, before, describe, it } from "node:test";
import { eventually, rect, settle, startServer, upsert } from "./helpers.js";

let app;
before(async () => {
  app = await startServer();
});
after(() => app.stop());

const setLink = (user, boardId, linkAccess) =>
  app.request(`/boards/${boardId}/link-access`, { method: "PATCH", user, body: { linkAccess } });
const invite = (owner, boardId, person) =>
  app.request(`/boards/${boardId}/collaborators`, { method: "POST", user: owner, body: { email: person.email } });

describe("who can open a board", () => {
  it("keeps new boards private: guests get 401, signed-in strangers get 403", async () => {
    const owner = await app.signUp("Owner");
    const stranger = await app.signUp("Stranger");
    const boardId = await app.createBoard(owner);

    const guest = await app.connect(null);
    const asGuest = await guest.join(boardId);
    assert.equal(asGuest.ok, false);
    assert.equal(asGuest.status, 401);

    const other = await app.connect(stranger);
    const asStranger = await other.join(boardId);
    assert.equal(asStranger.ok, false);
    assert.equal(asStranger.status, 403);
  });

  it("rejects a socket with a bad login token", async () => {
    await assert.rejects(app.connect({ token: "not-a-real-token" }), /unauthorized/);
  });

  it("answers 404 for a board that doesn't exist or isn't a valid id", async () => {
    const owner = await app.signUp("Owner");
    const client = await app.connect(owner);
    assert.equal((await client.join("nope")).status, 404);
    assert.equal((await client.join("64b7f0c2a1b2c3d4e5f60718")).status, 404);
  });

  it("lets the owner join as owner and invited people as editors, with emails visible", async () => {
    const owner = await app.signUp("Owner");
    const editor = await app.signUp("Editor");
    const boardId = await app.createBoard(owner);
    assert.equal((await invite(owner, boardId, editor)).status, 201);

    const asOwner = await (await app.connect(owner)).join(boardId);
    const asEditor = await (await app.connect(editor)).join(boardId);
    assert.equal(asOwner.board.role, "owner");
    assert.equal(asEditor.board.role, "editor");
    assert.equal(asEditor.board.owner.email, owner.email);
    assert.equal(asEditor.board.collaborators[0].email, editor.email);
  });
});

describe("link access settings", () => {
  it("only lets the owner change them, and only to known values", async () => {
    const owner = await app.signUp("Owner");
    const editor = await app.signUp("Editor");
    const stranger = await app.signUp("Stranger");
    const boardId = await app.createBoard(owner);
    await invite(owner, boardId, editor);

    assert.equal((await setLink(stranger, boardId, "view")).status, 403);
    assert.equal((await setLink(editor, boardId, "view")).status, 403);
    assert.equal((await setLink(owner, boardId, "everyone")).status, 400);
    const ok = await setLink(owner, boardId, "view");
    assert.equal(ok.status, 200);
    assert.equal(ok.data.board.linkAccess, "view");
  });
});

describe("anyone with the link can view", () => {
  it("opens for guests and signed-in strangers as read-only viewers, without emails", async () => {
    const owner = await app.signUp("Owner");
    const editor = await app.signUp("Editor");
    const stranger = await app.signUp("Stranger");
    const boardId = await app.createBoard(owner);
    await invite(owner, boardId, editor);
    await setLink(owner, boardId, "view");

    const guest = await app.connect(null);
    const guestJoin = await guest.join(boardId);
    assert.equal(guestJoin.ok, true);
    assert.equal(guestJoin.board.role, "viewer");
    assert.equal(guestJoin.board.owner.email, undefined);
    assert.deepEqual(guestJoin.board.collaborators, []);

    const signedIn = await app.connect(stranger);
    assert.equal((await signedIn.join(boardId)).board.role, "viewer");
  });

  it("refuses edits from viewers and never broadcasts them", async () => {
    const owner = await app.signUp("Owner");
    const stranger = await app.signUp("Stranger");
    const boardId = await app.createBoard(owner);
    await setLink(owner, boardId, "view");

    const watcher = await app.connect(owner);
    await watcher.join(boardId);
    const guest = await app.connect(null);
    await guest.join(boardId);
    const viewer = await app.connect(stranger);
    await viewer.join(boardId);

    for (const client of [guest, viewer]) {
      const result = await client.op(boardId, upsert(rect("sneaky")));
      assert.deepEqual(result, { ok: false, readOnly: true });
    }
    await settle();
    assert.equal(watcher.of("board:op").length, 0);
  });

  it("shows signed-in viewers and named guests in the presence list", async () => {
    const owner = await app.signUp("Owner");
    const boardId = await app.createBoard(owner);
    await setLink(owner, boardId, "view");

    const ownerClient = await app.connect(owner);
    await ownerClient.join(boardId);
    const guest = await app.connect(null, { guest: { id: "g_abcdef123456", name: "  Ada   Guest " } });
    await guest.join(boardId);

    const presence = await eventually(() => {
      const list = ownerClient.last("presence");
      return list?.length === 2 && list;
    }, { message: "both people in presence" });
    const guestEntry = presence.find((person) => person.guest);
    assert.equal(guestEntry.name, "Ada Guest");
    assert.equal(guestEntry.userId, "g_abcdef123456");

    guest.socket.emit("guest:rename", { name: "Ada L." });
    await eventually(() => ownerClient.last("presence")?.some((person) => person.name === "Ada L."), {
      message: "renamed guest in presence",
    });
  });
});

describe("anyone with the link can edit", () => {
  it("lets guests draw, shows their work to others, and keeps emails hidden", async () => {
    const owner = await app.signUp("Owner");
    const boardId = await app.createBoard(owner);
    await setLink(owner, boardId, "edit");

    const ownerClient = await app.connect(owner);
    await ownerClient.join(boardId);
    const guest = await app.connect(null);
    const joined = await guest.join(boardId);
    assert.equal(joined.board.role, "contributor");
    assert.equal(joined.board.owner.email, undefined);

    assert.deepEqual(await guest.op(boardId, upsert(rect("by-guest"))), { ok: true });
    await eventually(() => ownerClient.of("board:op").length === 1, { message: "the guest's drawing" });
  });

  it("still keeps invite management to the owner", async () => {
    const owner = await app.signUp("Owner");
    const stranger = await app.signUp("Stranger");
    const boardId = await app.createBoard(owner);
    await setLink(owner, boardId, "edit");
    assert.equal((await invite(stranger, boardId, stranger)).status, 403);
    assert.equal((await setLink(stranger, boardId, "restricted")).status, 403);
  });
});

describe("access changes reach people who already have the board open", () => {
  it("upgrades a viewer when they are invited, and downgrades them when removed", async () => {
    const owner = await app.signUp("Owner");
    const person = await app.signUp("Person");
    const boardId = await app.createBoard(owner);
    await setLink(owner, boardId, "view");

    const client = await app.connect(person);
    assert.equal((await client.join(boardId)).board.role, "viewer");
    assert.equal((await client.op(boardId, upsert(rect("nope")))).readOnly, true);

    await invite(owner, boardId, person);
    await eventually(() => client.last("board:role")?.role === "editor", { message: "upgrade to editor" });
    assert.equal((await client.op(boardId, upsert(rect("allowed")))).ok, true);
    const richMeta = client.last("board:meta");
    assert.equal(richMeta.collaborators[0].email, person.email, "members get the full list again");

    assert.equal((await app.request(`/boards/${boardId}/collaborators/${person.id}`, { method: "DELETE", user: owner })).status, 200);
    await eventually(() => client.last("board:role")?.role === "viewer", { message: "downgrade to viewer" });
    assert.equal(client.of("board:revoked").length, 0, "the link is still open, so they stay as a viewer");
    assert.equal((await client.op(boardId, upsert(rect("again")))).readOnly, true);
    assert.deepEqual(client.last("board:meta").collaborators, []);
  });

  it("moves viewers up to contributors when the link becomes editable", async () => {
    const owner = await app.signUp("Owner");
    const boardId = await app.createBoard(owner);
    await setLink(owner, boardId, "view");
    const guest = await app.connect(null);
    await guest.join(boardId);

    await setLink(owner, boardId, "edit");
    await eventually(() => guest.last("board:role")?.role === "contributor", { message: "guest becomes contributor" });
    assert.equal((await guest.op(boardId, upsert(rect("now-allowed")))).ok, true);
  });

  it("removes viewers and guests when the link closes, but keeps invited people", async () => {
    const owner = await app.signUp("Owner");
    const editor = await app.signUp("Editor");
    const viewer = await app.signUp("Viewer");
    const boardId = await app.createBoard(owner);
    await invite(owner, boardId, editor);
    await setLink(owner, boardId, "view");

    const editorClient = await app.connect(editor);
    await editorClient.join(boardId);
    const viewerClient = await app.connect(viewer);
    await viewerClient.join(boardId);
    const guest = await app.connect(null);
    await guest.join(boardId);

    await setLink(owner, boardId, "restricted");
    await eventually(() => viewerClient.of("board:revoked").length === 1, { message: "viewer revoked" });
    await eventually(() => guest.of("board:revoked").length === 1, { message: "guest revoked" });
    assert.equal(editorClient.of("board:revoked").length, 0);
    assert.equal(editorClient.last("board:meta").linkAccess, "restricted");

    assert.equal((await guest.op(boardId, upsert(rect("late")))).ok, false);
    assert.equal((await guest.join(boardId)).status, 401);
    assert.equal((await viewerClient.join(boardId)).status, 403);
  });

  it("sends everyone away when the owner removes someone who was invited and the link is closed", async () => {
    const owner = await app.signUp("Owner");
    const person = await app.signUp("Person");
    const boardId = await app.createBoard(owner);
    await invite(owner, boardId, person);

    const client = await app.connect(person);
    await client.join(boardId);
    await app.request(`/boards/${boardId}/collaborators/${person.id}`, { method: "DELETE", user: owner });
    await eventually(() => client.of("board:revoked").length === 1, { message: "revocation" });
    assert.equal((await client.op(boardId, upsert(rect("x")))).ok, false);
  });
});

describe("invites", () => {
  it("rejects unknown emails, the owner, and repeat invites", async () => {
    const owner = await app.signUp("Owner");
    const person = await app.signUp("Person");
    const boardId = await app.createBoard(owner);

    const unknown = await app.request(`/boards/${boardId}/collaborators`, { method: "POST", user: owner, body: { email: "nobody@example.test" } });
    assert.equal(unknown.status, 404);
    assert.equal((await invite(owner, boardId, owner)).status, 400);
    assert.equal((await invite(owner, boardId, person)).status, 201);
    assert.equal((await invite(owner, boardId, person)).status, 409);
    assert.equal((await app.request(`/boards/${boardId}/collaborators`, { method: "POST", user: owner, body: {} })).status, 400);
  });

  it("lets people leave on their own, but not the owner", async () => {
    const owner = await app.signUp("Owner");
    const person = await app.signUp("Person");
    const boardId = await app.createBoard(owner);
    await invite(owner, boardId, person);

    assert.equal((await app.request(`/boards/${boardId}/collaborators/me`, { method: "DELETE", user: owner })).status, 400);
    assert.equal((await app.request(`/boards/${boardId}/collaborators/me`, { method: "DELETE", user: person })).status, 200);
    assert.equal((await (await app.connect(person)).join(boardId)).status, 403);
  });

  it("stops editors removing other people", async () => {
    const owner = await app.signUp("Owner");
    const a = await app.signUp("A");
    const b = await app.signUp("B");
    const boardId = await app.createBoard(owner);
    await invite(owner, boardId, a);
    await invite(owner, boardId, b);
    const result = await app.request(`/boards/${boardId}/collaborators/${b.id}`, { method: "DELETE", user: a });
    assert.equal(result.status, 403);
  });
});
