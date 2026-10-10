import assert from "node:assert/strict";
import { after, before, describe, it } from "node:test";
import { Board } from "../src/models/board.model.ts";
import { Notification } from "../src/models/notification.model.ts";
import { Template } from "../src/models/template.model.ts";
import { findBoardForMember } from "../src/services/boards.ts";
import { eventually, rect, roundTrip, startServer, upsert } from "./helpers.js";

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
      assert.deepEqual(result, { ok: false, reason: "forbidden", readOnly: true });
    }
    await roundTrip(watcher);
    assert.equal(watcher.of("board:op").length, 0);
  });

  it("checks a change against the role on the board it's for, even while the socket is still joining it", async () => {
    // Someone who edits their own board moves to one they may only view, and sends changes for it straight away.
    const owner = await app.signUp("Owner");
    const viewer = await app.signUp("Viewer");
    const ownBoard = await app.createBoard(viewer);
    const viewOnly = await app.createBoard(owner);
    await setLink(owner, viewOnly, "view");
    const client = await app.connect(viewer);
    assert.equal((await client.join(ownBoard)).board.role, "owner");

    // Joining looks up how much space the board's owner has left; slowed down, it holds the join open.
    const aggregate = Template.aggregate;
    Template.aggregate = function (...args) {
      const query = aggregate.apply(this, args);
      const exec = query.exec.bind(query);
      query.exec = () => new Promise((resolve) => setTimeout(resolve, 300)).then(exec);
      return query;
    };
    try {
      let joined = false;
      const joining = client.join(viewOnly).then((reply) => {
        joined = true;
        return reply;
      });
      const replies = [];
      for (let i = 0; !joined && i < 100; i++) {
        replies.push(await client.op(viewOnly, upsert(rect(`sneaky-${i}`))));
        await new Promise((resolve) => setTimeout(resolve, 10));
      }
      assert.equal((await joining).board.role, "viewer");
      assert.ok(replies.length > 0);
      assert.deepEqual(
        replies.filter((reply) => reply.ok),
        [],
        "no change was taken with the role from the board the socket came from",
      );
    } finally {
      Template.aggregate = aggregate;
    }
    const board = await Board.findById(viewOnly);
    assert.equal(board.elements.length, 0);
  });

  it("shows signed-in viewers and named guests in the presence list", async () => {
    const owner = await app.signUp("Owner");
    const boardId = await app.createBoard(owner);
    await setLink(owner, boardId, "view");

    const ownerClient = await app.connect(owner);
    await ownerClient.join(boardId);
    const guest = await app.connect(null, { guest: { id: "g_abcdef123456", name: "  Ada   Guest " } });
    await guest.join(boardId);

    const presence = await eventually(
      () => {
        const list = ownerClient.last("presence");
        return list?.length === 2 && list;
      },
      { message: "both people in presence" },
    );
    const guestEntry = presence.find((person) => person.guest);
    assert.equal(guestEntry.name, "Ada Guest");
    assert.equal(guestEntry.userId, "g_abcdef123456");

    guest.socket.emit("guest:rename", { name: "Ada L." });
    await eventually(() => ownerClient.last("presence")?.some((person) => person.name === "Ada L."), {
      message: "renamed guest in presence",
    });
  });

  it("gives a guest whose id isn't a string an id of its own", async () => {
    const owner = await app.signUp("Owner");
    const boardId = await app.createBoard(owner);
    await setLink(owner, boardId, "view");
    // A list holding a valid id reads as one when turned into text, which is all the pattern looks at.
    const guest = await app.connect(null, { guest: { id: ["g_abcdef123456"], name: "Listed" } });
    await guest.join(boardId);
    const presence = await eventually(() => guest.last("presence")?.find((person) => person.name === "Listed"), {
      message: "the guest in presence",
    });
    assert.equal(typeof presence.userId, "string");
    assert.notEqual(presence.userId, "g_abcdef123456");
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

    assert.equal(
      (await app.request(`/boards/${boardId}/collaborators/${person.id}`, { method: "DELETE", user: owner })).status,
      200,
    );
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

    const unknown = await app.request(`/boards/${boardId}/collaborators`, {
      method: "POST",
      user: owner,
      body: { email: "nobody@example.test" },
    });
    assert.equal(unknown.status, 404);
    assert.equal((await invite(owner, boardId, owner)).status, 400);
    assert.equal((await invite(owner, boardId, person)).status, 201);
    assert.equal((await invite(owner, boardId, person)).status, 409);
    assert.equal(
      (await app.request(`/boards/${boardId}/collaborators`, { method: "POST", user: owner, body: {} })).status,
      400,
    );
  });

  it("lets people leave on their own, but not the owner", async () => {
    const owner = await app.signUp("Owner");
    const person = await app.signUp("Person");
    const boardId = await app.createBoard(owner);
    await invite(owner, boardId, person);

    assert.equal(
      (await app.request(`/boards/${boardId}/collaborators/me`, { method: "DELETE", user: owner })).status,
      400,
    );
    assert.equal(
      (await app.request(`/boards/${boardId}/collaborators/me`, { method: "DELETE", user: person })).status,
      200,
    );
    assert.equal((await (await app.connect(person)).join(boardId)).status, 403);
  });

  it("adds someone once, and notifies them once, however many invites arrive at the same moment", async () => {
    const owner = await app.signUp("Owner");
    const person = await app.signUp("Ed");
    const boardId = await app.createBoard(owner);

    const results = await Promise.all([1, 2, 3].map(() => invite(owner, boardId, person)));
    assert.deepEqual(results.map((result) => result.status).sort(), [201, 409, 409]);
    const board = await Board.findById(boardId).lean();
    assert.deepEqual(board.collaborators.map(String), [person.id]);
    assert.equal(await Notification.countDocuments({ user: person.id, type: "invite" }), 1);
  });

  it("answers removals sent at the same moment with 200 and 404, never an error", async () => {
    const owner = await app.signUp("Owner");
    const person = await app.signUp("Person");
    const boardId = await app.createBoard(owner);
    await invite(owner, boardId, person);

    const remove = () =>
      app.request(`/boards/${boardId}/collaborators/${person.id}`, { method: "DELETE", user: owner });
    const results = await Promise.all([remove(), remove(), remove()]);
    assert.deepEqual(results.map((result) => result.status).sort(), [200, 404, 404]);
  });

  it("answers 404 for a person who isn't on the board or isn't a valid id, and changes nothing", async () => {
    const owner = await app.signUp("Owner");
    const stranger = await app.signUp("Stranger");
    const boardId = await app.createBoard(owner);
    const before = await Board.findById(boardId).lean();

    for (const target of ["not-an-id", stranger.id]) {
      const result = await app.request(`/boards/${boardId}/collaborators/${target}`, { method: "DELETE", user: owner });
      assert.equal(result.status, 404, target);
    }
    assert.deepEqual((await Board.findById(boardId).lean()).updatedAt, before.updatedAt);
  });

  it("doesn't count inviting, removing or sharing as editing the board", async () => {
    const owner = await app.signUp("Owner");
    const person = await app.signUp("Person");
    const boardId = await app.createBoard(owner);
    const stamp = async () => (await Board.findById(boardId).lean()).updatedAt.getTime();
    const created = await stamp();

    await invite(owner, boardId, person);
    await setLink(owner, boardId, "view");
    await app.request(`/boards/${boardId}/collaborators/${person.id}`, { method: "DELETE", user: owner });
    assert.equal(await stamp(), created);
  });

  it("drops a removed person's star, and tells someone who leaves nothing members alone see", async () => {
    const owner = await app.signUp("Owner");
    const person = await app.signUp("Person");
    const boardId = await app.createBoard(owner);
    await invite(owner, boardId, person);
    await app.request(`/boards/${boardId}/star`, { method: "PUT", user: person, body: { starred: true } });

    const left = await app.request(`/boards/${boardId}/collaborators/me`, { method: "DELETE", user: person });
    assert.equal(left.status, 200);
    assert.deepEqual(left.data.board.collaborators, []);
    assert.equal(left.data.board.owner.email, undefined);
    assert.deepEqual((await Board.findById(boardId).lean()).starredBy, []);
  });

  it("only stars or unstars when told with true or false", async () => {
    const owner = await app.signUp("Owner");
    const boardId = await app.createBoard(owner);
    const star = (starred) => app.request(`/boards/${boardId}/star`, { method: "PUT", user: owner, body: { starred } });
    assert.equal((await star("false")).status, 400);
    assert.equal((await star(0)).status, 400);
    assert.equal((await star(true)).data.starred, true);
    assert.equal((await star(false)).data.starred, false);
  });

  it("loads a board without its drawing unless asked for it", async () => {
    const owner = await app.signUp("Owner");
    const boardId = await app.createBoard(owner);
    await Board.updateOne({ _id: boardId }, { $set: { elements: [rect("a")] } });

    assert.equal((await findBoardForMember(boardId, owner.id)).elements, undefined);
    const withDrawing = await findBoardForMember(boardId, owner.id, { elements: true });
    assert.deepEqual(
      withDrawing.elements.map((element) => element.id),
      ["a"],
    );
    // The routes that need the drawing still send it.
    assert.equal((await app.request(`/boards/${boardId}`, { user: owner })).data.board.elements.length, 1);
    const client = await app.connect(owner);
    assert.equal((await client.join(boardId)).board.elements.length, 1);
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
