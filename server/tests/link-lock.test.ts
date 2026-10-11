import assert from "node:assert/strict";
import { after, before, describe, it } from "node:test";
import type { BoardListReply, BoardMetaReply, LinkPassReply } from "@inkboard/shared/api";
import { eventually, startServer } from "./helpers.ts";
import type { ServerInstance, TestUser } from "./helpers.ts";

let app: ServerInstance;
before(async () => {
  app = await startServer();
});
after(() => app.stop());

// Changes the link's settings as `user`, and answers with what the server said.
const setLink = (user: TestUser, id: string, body: Record<string, unknown>) =>
  app.request<BoardMetaReply & { error?: string }>(`/boards/${id}/link-access`, { method: "PATCH", user, body });
const unlock = (id: string, password: unknown, user?: TestUser) =>
  app.request<LinkPassReply & { error?: string }>(`/boards/${id}/unlock`, { method: "POST", user, body: { password } });
const listed = async (user: TestUser) =>
  (await app.request<BoardListReply>("/boards", { user })).data.boards.map((board) => board.id);
const invite = (owner: TestUser, id: string, person: TestUser) =>
  app.request(`/boards/${id}/collaborators`, { method: "POST", user: owner, body: { email: person.email } });

/** A board shared by link to view, with a password on the link. */
async function locked(password = "open sesame") {
  const owner = await app.signUp("Owner");
  const id = await app.createBoard(owner, "Locked");
  await setLink(owner, id, { linkAccess: "view" });
  const { status, data } = await setLink(owner, id, { password });
  assert.equal(status, 200, data.error);
  return { owner, id };
}

describe("a link password", () => {
  it("is asked of guests, and the pass for it opens the board", async () => {
    const { owner, id } = await locked();
    const meta = (await app.request<{ board: { linkPassword: boolean } }>(`/boards/${id}`, { user: owner })).data;
    assert.equal(meta.board.linkPassword, true);

    const guest = await app.connect(null);
    const refused = await guest.join(id);
    assert.deepEqual([refused.ok, refused.status, refused.locked], [false, 403, "password"]);

    assert.equal((await unlock(id, "wrong")).status, 403);
    assert.equal((await unlock(id, undefined)).status, 403);
    const { status, data } = await unlock(id, "open sesame");
    assert.equal(status, 200);
    assert.ok(data.pass.length > 20);

    assert.equal((await guest.join(id, { pass: "not the pass" })).locked, "password");
    const joined = await guest.join(id, { pass: data.pass });
    assert.equal(joined.ok, true);
    assert.equal(joined.board.role, "viewer");
  });

  it("is never asked of the owner or the people invited", async () => {
    const { owner, id } = await locked();
    const editor = await app.signUp("Editor");
    await invite(owner, id, editor);
    for (const user of [owner, editor]) {
      assert.equal((await (await app.connect(user)).join(id)).ok, true);
    }
  });

  it("is remembered for someone signed in, so the board stays on their dashboard", async () => {
    const { id } = await locked();
    const visitor = await app.signUp("Visitor");
    const tab = await app.connect(visitor);
    assert.equal((await tab.join(id)).locked, "password");
    assert.equal((await unlock(id, "open sesame", visitor)).status, 200);

    assert.equal((await tab.join(id)).ok, true, "no pass needed now");
    assert.ok((await listed(visitor)).includes(id));
  });

  it("is remembered for someone who gave it as a guest and logged in since", async () => {
    const { id } = await locked();
    const { pass } = (await unlock(id, "open sesame")).data;
    const visitor = await app.signUp("Visitor");
    assert.equal((await (await app.connect(visitor)).join(id, { pass })).ok, true);
    assert.ok((await listed(visitor)).includes(id));
    assert.equal((await (await app.connect(visitor)).join(id)).ok, true, "and doesn't need the pass again");
  });

  it("ends every pass when it changes, and drops the people on the board who came by the link", async () => {
    const { owner, id } = await locked();
    const visitor = await app.signUp("Visitor");
    await unlock(id, "open sesame", visitor);
    const { pass } = (await unlock(id, "open sesame")).data;
    const guest = await app.connect(null);
    assert.equal((await guest.join(id, { pass })).ok, true);
    const tab = await app.connect(visitor);
    assert.equal((await tab.join(id)).ok, true);

    await setLink(owner, id, { password: "new password" });
    for (const socket of [guest, tab]) {
      const revoked = await eventually(() => socket.of("board:revoked")[0], { message: "being dropped" });
      assert.equal(revoked.locked, "password");
    }
    assert.equal((await (await app.connect(null)).join(id, { pass })).locked, "password", "the old pass is no good");
    assert.ok(!(await listed(visitor)).includes(id), "asked again");
    assert.equal((await unlock(id, "open sesame")).status, 403);
    assert.equal((await unlock(id, "new password")).status, 200);
  });

  it("can be removed, and then nobody is asked", async () => {
    const { owner, id } = await locked();
    const { status, data } = await setLink(owner, id, { password: null });
    assert.equal(status, 200);
    assert.equal(data.board.linkPassword, false);
    assert.equal((await (await app.connect(null)).join(id)).ok, true);
    assert.deepEqual((await unlock(id, "anything")).data, { pass: "" });
  });

  it("is set only by the owner, and must be a sensible length", async () => {
    const { owner, id } = await locked();
    assert.equal((await setLink(owner, id, { password: "abc" })).status, 400);
    assert.equal((await setLink(owner, id, { password: "x".repeat(101) })).status, 400);
    assert.equal((await setLink(owner, id, { password: 1234 })).status, 400);
    const editor = await app.signUp("Editor");
    await invite(owner, id, editor);
    assert.equal((await setLink(editor, id, { password: "mine now" })).status, 403);
  });

  it("isn't asked when the link is restricted, which opens the board to nobody", async () => {
    const { owner, id } = await locked();
    await setLink(owner, id, { linkAccess: "restricted" });
    const reply = await (await app.connect(null)).join(id);
    assert.equal(reply.status, 401);
    assert.equal(reply.locked, undefined, "nothing to unlock");
    assert.equal((await unlock(id, "open sesame")).status, 404);
  });

  it("can't be guessed at for long", async () => {
    const { id } = await locked();
    const statuses: number[] = [];
    for (let attempt = 0; attempt < 11; attempt += 1) statuses.push((await unlock(id, `guess ${attempt}`)).status);
    assert.deepEqual(statuses, [...Array<number>(10).fill(403), 429]);
  });
});

describe("a link that expires", () => {
  it("stops opening the board, and drops the people on it who came by the link, when the time comes", async () => {
    const owner = await app.signUp("Owner");
    const editor = await app.signUp("Editor");
    const visitor = await app.signUp("Visitor");
    const id = await app.createBoard(owner, "Soon gone");
    await invite(owner, id, editor);
    const expiresAt = new Date(Date.now() + 1500).toISOString();
    const { data } = await setLink(owner, id, { linkAccess: "view", expiresAt });
    assert.equal(data.board.linkExpiresAt, expiresAt);

    const guest = await app.connect(null);
    assert.equal((await guest.join(id)).ok, true);
    await (await app.connect(visitor)).join(id);
    assert.ok((await listed(visitor)).includes(id));
    const editorTab = await app.connect(editor);
    await editorTab.join(id);

    const revoked = await eventually(() => guest.of("board:revoked")[0], {
      timeout: 6000,
      message: "the guest being dropped",
    });
    assert.equal(revoked.locked, "expired");
    assert.equal((await (await app.connect(null)).join(id)).locked, "expired");
    assert.equal((await unlock(id, "")).status, 403);
    assert.ok(!(await listed(visitor)).includes(id));
    assert.equal(editorTab.of("board:revoked").length, 0, "invited people keep it");
    assert.equal((await (await app.connect(editor)).join(id)).ok, true);

    // No expiry, or a new one, opens it again.
    await setLink(owner, id, { expiresAt: null });
    assert.equal((await (await app.connect(null)).join(id)).ok, true);
  });

  it("must be in the future and within a year", async () => {
    const owner = await app.signUp("Owner");
    const id = await app.createBoard(owner);
    const at = (ms: number) => new Date(Date.now() + ms).toISOString();
    assert.equal((await setLink(owner, id, { expiresAt: at(-1000) })).status, 400);
    assert.equal((await setLink(owner, id, { expiresAt: at(400 * 24 * 3600 * 1000) })).status, 400);
    assert.equal((await setLink(owner, id, { expiresAt: "next Tuesday" })).status, 400);
    assert.equal((await setLink(owner, id, { expiresAt: at(24 * 3600 * 1000) })).status, 200);
  });
});
