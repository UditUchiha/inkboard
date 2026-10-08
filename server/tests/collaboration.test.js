import assert from "node:assert/strict";
import { after, before, describe, it } from "node:test";
import mongoose from "mongoose";
import { Version } from "../src/models/version.model.js";
import { pruneVersions, recordVersion, VERSION_LIMITS } from "../src/services/versions.js";
import { eventually, rect, settle, startServer, upsert } from "./helpers.js";

let app;
before(async () => {
  app = await startServer();
});
after(() => app.stop());

const invite = (owner, id, person) => app.request(`/boards/${id}/collaborators`, { method: "POST", user: owner, body: { email: person.email } });
const setLink = (user, id, linkAccess) => app.request(`/boards/${id}/link-access`, { method: "PATCH", user, body: { linkAccess } });

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
  { id, type: "pen", points: Array.from({ length: Math.ceil(bytes / 44) }, (_, i) => [i + 0.25, i + 0.5, 0.5]), pressure: false, stroke: "#16213a", penSize: 8 },
];

/** A board with an owner and one invited editor. */
async function team() {
  const owner = await app.signUp("Owner");
  const editor = await app.signUp("Editor");
  const id = await app.createBoard(owner, "Team board");
  await invite(owner, id, editor);
  return { owner, editor, id };
}

describe("version history", () => {
  it("saves named versions of the board as it is right now, including unsaved changes", async () => {
    const { owner, id } = await team();
    const client = await app.connect(owner);
    await client.join(id);
    await client.op(id, upsert(rect("live-only")));

    const saved = await app.request(`/boards/${id}/versions`, { method: "POST", user: owner, body: { label: "  Milestone 1 " } });
    assert.equal(saved.status, 201);
    assert.equal(saved.data.version.label, "Milestone 1");
    assert.equal(saved.data.version.kind, "named");
    assert.equal(saved.data.version.elementCount, 1);
    assert.equal(saved.data.version.author.name, "Owner");

    const detail = await app.request(`/boards/${id}/versions/${saved.data.version.id}`, { user: owner });
    assert.deepEqual(detail.data.version.elements.map((element) => element.id), ["live-only"]);
  });

  it("needs a sensible name", async () => {
    const { owner, id } = await team();
    const save = (label) => app.request(`/boards/${id}/versions`, { method: "POST", user: owner, body: { label } });
    assert.equal((await save("")).status, 400);
    assert.equal((await save("x".repeat(61))).status, 400);
    assert.equal((await save(undefined)).status, 400);
  });

  it("lists newest first, without the drawings", async () => {
    const { owner, id } = await team();
    const save = (label) => app.request(`/boards/${id}/versions`, { method: "POST", user: owner, body: { label } });
    await save("first");
    await settle(20);
    await save("second");
    const { data } = await app.request(`/boards/${id}/versions`, { user: owner });
    assert.deepEqual(data.versions.map((version) => version.label), ["second", "first"]);
    assert.equal(data.versions[0].elements, undefined);
  });

  it("restores an older version for everyone, after saving what was there so the restore can be undone", async () => {
    const { owner, editor, id } = await team();
    const ownerClient = await app.connect(owner);
    const editorClient = await app.connect(editor);
    await ownerClient.join(id);
    await editorClient.join(id);

    await ownerClient.op(id, upsert(rect("original")));
    const { data } = await app.request(`/boards/${id}/versions`, { method: "POST", user: owner, body: { label: "Good state" } });
    await editorClient.op(id, upsert(rect("regrettable")));

    const restored = await app.request(`/boards/${id}/versions/${data.version.id}/restore`, { method: "POST", user: editor });
    assert.equal(restored.status, 200);
    assert.deepEqual(restored.data.elements.map((element) => element.id), ["original"]);

    const reset = await eventually(() => ownerClient.of("board:reset")[0], { message: "the reset broadcast" });
    assert.deepEqual(reset.elements.map((element) => element.id), ["original"]);
    assert.equal(reset.by, "Editor");

    const { data: history } = await app.request(`/boards/${id}/versions`, { user: owner });
    const safety = history.versions.find((version) => version.kind === "restore");
    assert.ok(safety, "the state before the restore was kept");
    assert.equal(safety.elementCount, 2);

    const rejoined = await (await app.connect(owner)).join(id);
    assert.deepEqual(rejoined.board.elements.map((element) => element.id), ["original"]);
  });

  it("takes an automatic checkpoint before a burst of work, but not again straight away", async () => {
    const { owner, id } = await team();
    const client = await app.connect(owner);
    await client.join(id);
    await client.op(id, upsert(rect("a")));
    await client.op(id, upsert(rect("b")));
    await client.op(id, upsert(rect("c")));

    const autos = await eventually(async () => {
      const { data } = await app.request(`/boards/${id}/versions`, { user: owner });
      const found = data.versions.filter((version) => version.kind === "auto");
      return found.length > 0 && found;
    }, { message: "an automatic version" });
    await settle();
    assert.equal(autos.length, 1);
    assert.equal(autos[0].elementCount, 1, "it holds the board as it was before the burst");
    const { data } = await app.request(`/boards/${id}/versions`, { user: owner });
    assert.equal(data.versions.filter((version) => version.kind === "auto").length, 1);
  });

  it("keeps only the newest automatic versions but never prunes named ones", async () => {
    const { owner, id } = await team();
    await recordVersion(id, [rect("n")], { kind: "named", label: "Keep me", author: owner.id });
    for (let index = 0; index < 55; index += 1) await recordVersion(id, [rect(`e${index}`)], { kind: "auto" });
    assert.equal(await Version.countDocuments({ board: id, kind: "auto" }), 50);
    assert.equal(await Version.countDocuments({ board: id, kind: "named" }), 1);
  });

  it("trims the oldest autosaves to keep a board's history within its space, but always keeps the newest few", async () => {
    const { owner, id } = await team();
    await withVersionLimits({ bytes: 500_000 }, async () => {
      await recordVersion(id, drawing(200_000), { kind: "named", label: "Big keeper", author: owner.id });
      for (let index = 0; index < 8; index += 1) await recordVersion(id, drawing(60_000, `e${index}`), { kind: "auto" });

      const autos = await Version.find({ board: id, kind: "auto" }).sort({ createdAt: -1 }).lean();
      const total = (await Version.find({ board: id }).lean()).reduce((sum, version) => sum + version.bytes, 0);
      assert.ok(total <= 500_000, `history takes ${total} bytes`);
      assert.ok(autos.length >= 3 && autos.length < 8, `${autos.length} autosaves kept`);
      assert.equal(autos[0].elements[0].id, "e7", "the newest are the ones kept");
      assert.equal(await Version.countDocuments({ board: id, kind: "named" }), 1);

      // Even far over budget, the newest three autosaves stay.
      for (let index = 0; index < 3; index += 1) await recordVersion(id, drawing(400_000, `big${index}`), { kind: "auto" });
      assert.equal(await Version.countDocuments({ board: id, kind: "auto" }), 3);
    });
  });

  it("keeps only the newest before-restore snapshots", async () => {
    const { id } = await team();
    await withVersionLimits({ restore: 2 }, async () => {
      for (let index = 0; index < 4; index += 1) await recordVersion(id, [rect(`r${index}`)], { kind: "restore" });
      const kept = await Version.find({ board: id, kind: "restore" }).sort({ createdAt: -1 }).lean();
      assert.deepEqual(kept.map((version) => version.elements[0].id), ["r3", "r2"]);
    });
  });

  it("measures versions saved before sizes were recorded", async () => {
    const { id } = await team();
    const old = await Version.collection.insertOne({ board: new mongoose.Types.ObjectId(id), kind: "auto", elements: drawing(10_000), elementCount: 1, createdAt: new Date(0) });
    await pruneVersions(id);
    const measured = await Version.findById(old.insertedId).lean();
    assert.ok(measured.bytes > 5_000, `measured ${measured.bytes} bytes`);
  });

  it("refuses a new saved version when there are too many, or no room, and explains why", async () => {
    const { owner, id } = await team();
    const save = (label) => app.request(`/boards/${id}/versions`, { method: "POST", user: owner, body: { label } });
    await withVersionLimits({ named: 2 }, async () => {
      assert.equal((await save("one")).status, 201);
      assert.equal((await save("two")).status, 201);
      const refused = await save("three");
      assert.equal(refused.status, 400);
      assert.match(refused.data.error, /2 saved versions.*Delete one/);
    });
    await withVersionLimits({ bytes: 1 }, async () => {
      const refused = await save("too big");
      assert.equal(refused.status, 400);
      assert.match(refused.data.error, /used up their space/);
    });
  });

  it("lets members delete saved versions, but not autosaves, and not anyone else", async () => {
    const { owner, editor, id } = await team();
    const viewer = await app.signUp("Viewer");
    await setLink(owner, id, "view");
    const { data } = await app.request(`/boards/${id}/versions`, { method: "POST", user: owner, body: { label: "Old idea" } });
    const auto = await recordVersion(id, [rect("a")], { kind: "auto" });
    const remove = (user, versionId) => app.request(`/boards/${id}/versions/${versionId}`, { method: "DELETE", user });

    assert.equal((await remove(viewer, data.version.id)).status, 403);
    assert.equal((await remove(editor, auto.id)).status, 400);
    assert.equal((await remove(editor, data.version.id)).status, 204);
    assert.equal((await remove(editor, data.version.id)).status, 404);
    const { data: history } = await app.request(`/boards/${id}/versions`, { user: owner });
    assert.deepEqual(history.versions.map((version) => version.kind), ["auto"]);
  });

  it("is for members only, and a version can only be fetched through its own board", async () => {
    const { owner, id } = await team();
    const viewer = await app.signUp("Viewer");
    const otherId = await app.createBoard(owner, "Other");
    await setLink(owner, id, "view");
    const { data } = await app.request(`/boards/${id}/versions`, { method: "POST", user: owner, body: { label: "v" } });

    assert.equal((await app.request(`/boards/${id}/versions`, { user: viewer })).status, 403);
    assert.equal((await app.request(`/boards/${id}/versions`, { method: "POST", user: viewer, body: { label: "x" } })).status, 403);
    assert.equal((await app.request(`/boards/${id}/versions/${data.version.id}/restore`, { method: "POST", user: viewer })).status, 403);
    assert.equal((await app.request(`/boards/${otherId}/versions/${data.version.id}`, { user: owner })).status, 404);
    assert.equal((await app.request(`/boards/${id}/versions/not-an-id`, { user: owner })).status, 404);
  });
});

describe("comments", () => {
  const comment = (user, id, body) => app.request(`/boards/${id}/threads`, { method: "POST", user, body });

  it("lets editors start a thread pinned to the canvas, and mention members", async () => {
    const { owner, editor, id } = await team();
    const { status, data } = await comment(editor, id, { x: 120, y: -40, body: "  Looks off @Owner ", mentions: [owner.id] });
    assert.equal(status, 201);
    assert.equal(data.thread.x, 120);
    assert.equal(data.thread.messages[0].body, "Looks off @Owner");
    assert.deepEqual(data.thread.messages[0].mentions.map((person) => person.id), [owner.id]);

    const list = await app.request(`/boards/${id}/threads`, { user: owner });
    assert.equal(list.data.threads.length, 1);
  });

  it("only mentions people who are on the board", async () => {
    const { editor, id } = await team();
    const outsider = await app.signUp("Outsider");
    const { data } = await comment(editor, id, { x: 0, y: 0, body: "hi", mentions: [outsider.id, "garbage"] });
    assert.deepEqual(data.thread.messages[0].mentions, []);
    assert.equal((await app.request("/notifications", { user: outsider })).data.notifications.length, 0);
  });

  it("validates position and text", async () => {
    const { editor, id } = await team();
    assert.equal((await comment(editor, id, { x: "left", y: 0, body: "x" })).status, 400);
    assert.equal((await comment(editor, id, { x: 0, y: 0, body: "   " })).status, 400);
    assert.equal((await comment(editor, id, { x: 0, y: 0, body: "x".repeat(2001) })).status, 400);
  });

  it("lets signed-in viewers read comments but not write them, and keeps guests out", async () => {
    const owner = await app.signUp("Owner");
    const editor = await app.signUp("Editor");
    const viewer = await app.signUp("Viewer");
    const id = await app.createBoard(owner, "Public");
    await invite(owner, id, editor);
    await setLink(owner, id, "view");
    await comment(editor, id, { x: 1, y: 1, body: "note" });

    const read = await app.request(`/boards/${id}/threads`, { user: viewer });
    assert.equal(read.status, 200);
    assert.equal(read.data.threads.length, 1);
    assert.equal((await comment(viewer, id, { x: 0, y: 0, body: "can't" })).status, 403);
    assert.equal((await app.request(`/boards/${id}/threads`)).status, 401);
  });

  it("lets signed-in contributors comment when the link allows editing", async () => {
    const owner = await app.signUp("Owner");
    const stranger = await app.signUp("Stranger");
    const id = await app.createBoard(owner);
    await setLink(owner, id, "edit");
    const { status } = await comment(stranger, id, { x: 0, y: 0, body: "from the link" });
    assert.equal(status, 201);
  });

  it("notifies mentioned people, and notifies earlier participants about replies, but never the author", async () => {
    const { owner, editor, id } = await team();
    const { data } = await comment(editor, id, { x: 0, y: 0, body: "question for you", mentions: [owner.id] });
    const threadId = data.thread.id;

    const first = await app.request("/notifications", { user: owner });
    assert.equal(first.data.unread, 1);
    assert.equal(first.data.notifications[0].type, "mention");
    assert.equal(first.data.notifications[0].actor.name, "Editor");
    assert.equal(first.data.notifications[0].board.title, "Team board");
    const own = (await app.request("/notifications", { user: editor })).data.notifications;
    assert.deepEqual(own.map((n) => n.type), ["invite"], "the author isn't notified about their own comment");

    const reply = await app.request(`/boards/${id}/threads/${threadId}/messages`, { method: "POST", user: owner, body: { body: "answer" } });
    assert.equal(reply.status, 201);
    assert.equal(reply.data.thread.messages.length, 2);
    const forEditor = (await app.request("/notifications", { user: editor })).data.notifications;
    assert.deepEqual(forEditor.map((n) => n.type).sort(), ["invite", "reply"], "a reply notification, on top of the earlier invite");
  });

  it("reopens a resolved thread on reply, and lets editors resolve or move it", async () => {
    const { owner, editor, id } = await team();
    const { data } = await comment(editor, id, { x: 0, y: 0, body: "todo" });
    const url = `/boards/${id}/threads/${data.thread.id}`;

    const resolved = await app.request(url, { method: "PATCH", user: owner, body: { resolved: true, x: 50, y: 60 } });
    assert.equal(resolved.data.thread.resolved, true);
    assert.equal(resolved.data.thread.x, 50);
    assert.equal((await app.request(url, { method: "PATCH", user: owner, body: { x: "far" } })).status, 400);

    const reply = await app.request(`${url}/messages`, { method: "POST", user: editor, body: { body: "not done" } });
    assert.equal(reply.data.thread.resolved, false);
  });

  it("can be deleted only by their author or the board's owner", async () => {
    const { owner, editor, id } = await team();
    const other = await app.signUp("Other");
    await invite(owner, id, other);
    const a = (await comment(editor, id, { x: 0, y: 0, body: "mine" })).data.thread.id;
    const b = (await comment(editor, id, { x: 0, y: 0, body: "also mine" })).data.thread.id;

    assert.equal((await app.request(`/boards/${id}/threads/${a}`, { method: "DELETE", user: other })).status, 403);
    assert.equal((await app.request(`/boards/${id}/threads/${a}`, { method: "DELETE", user: editor })).status, 204);
    assert.equal((await app.request(`/boards/${id}/threads/${b}`, { method: "DELETE", user: owner })).status, 204);
    assert.equal((await app.request(`/boards/${id}/threads/${b}`, { method: "DELETE", user: owner })).status, 404);
    assert.deepEqual((await app.request(`/boards/${id}/threads`, { user: owner })).data.threads, []);
  });

  it("are pushed live to signed-in people on the board, but not to guests", async () => {
    const owner = await app.signUp("Owner");
    const editor = await app.signUp("Editor");
    const id = await app.createBoard(owner);
    await invite(owner, id, editor);
    await setLink(owner, id, "view");
    const signedIn = await app.connect(owner);
    const guest = await app.connect(null);
    await signedIn.join(id);
    await guest.join(id);

    await comment(editor, id, { x: 5, y: 5, body: "live" });
    await eventually(() => signedIn.of("thread:upsert").length === 1, { message: "the live comment" });
    await settle();
    assert.equal(guest.of("thread:upsert").length, 0);

    const thread = signedIn.last("thread:upsert");
    await app.request(`/boards/${id}/threads/${thread.id}`, { method: "DELETE", user: editor });
    await eventually(() => signedIn.of("thread:delete").length === 1, { message: "the deletion" });
    assert.equal(guest.of("thread:delete").length, 0);
  });
});

describe("notifications", () => {
  it("tell someone they were invited, and arrive live on their open tabs", async () => {
    const owner = await app.signUp("Owner");
    const person = await app.signUp("Person");
    const id = await app.createBoard(owner, "Invite me");
    const tab = await app.connect(person);

    await invite(owner, id, person);
    const pushed = await eventually(() => tab.of("notification")[0], { message: "the live notification" });
    assert.equal(pushed.type, "invite");
    assert.equal(pushed.board.title, "Invite me");

    const { data } = await app.request("/notifications", { user: person });
    assert.equal(data.unread, 1);
    assert.equal(data.notifications[0].actor.name, "Owner");
  });

  it("can be marked read one by one or all at once", async () => {
    const person = await app.signUp("Person");
    for (const title of ["One", "Two", "Three"]) {
      const owner = await app.signUp("Inviter");
      const id = await app.createBoard(owner, title);
      await invite(owner, id, person);
    }
    const { data } = await app.request("/notifications", { user: person });
    assert.equal(data.unread, 3);

    assert.equal((await app.request("/notifications/read", { method: "POST", user: person, body: { ids: [data.notifications[0].id, "bad"] } })).status, 204);
    assert.equal((await app.request("/notifications", { user: person })).data.unread, 2);
    assert.equal((await app.request("/notifications/read", { method: "POST", user: person, body: {} })).status, 204);
    assert.equal((await app.request("/notifications", { user: person })).data.unread, 0);
  });

  it("stay private to each person and drop out when their board is trashed", async () => {
    const owner = await app.signUp("Owner");
    const person = await app.signUp("Person");
    const bystander = await app.signUp("Bystander");
    const id = await app.createBoard(owner, "Doomed");
    await invite(owner, id, person);

    assert.equal((await app.request("/notifications", { user: bystander })).data.notifications.length, 0);
    await app.request(`/boards/${id}`, { method: "DELETE", user: owner });
    assert.equal((await app.request("/notifications", { user: person })).data.notifications.length, 0);
  });
});

describe("templates", () => {
  const save = (user, boardId, title) => app.request("/templates", { method: "POST", user, body: { boardId, title } });

  it("save a board's drawing and start new boards from it", async () => {
    const owner = await app.signUp("Owner");
    const id = await app.createBoard(owner, "Retro layout");
    const client = await app.connect(owner);
    await client.join(id);
    await client.op(id, upsert(rect("t1"), rect("t2")));

    const made = await save(owner, id, "  Retro ");
    assert.equal(made.status, 201);
    assert.equal(made.data.template.title, "Retro");
    assert.equal(made.data.template.elements.length, 2);
    assert.equal((await app.request("/templates", { user: owner })).data.templates.length, 1);

    const fromTemplate = await app.request("/boards", { method: "POST", user: owner, body: { templateId: made.data.template.id } });
    assert.equal(fromTemplate.status, 201);
    assert.equal(fromTemplate.data.board.title, "Retro", "the template's name is the default title");
    assert.deepEqual(fromTemplate.data.board.elements.map((element) => element.id), ["t1", "t2"]);
  });

  it("refuse an empty board, a long name, or a board you can't change", async () => {
    const owner = await app.signUp("Owner");
    const stranger = await app.signUp("Stranger");
    const empty = await app.createBoard(owner);
    assert.equal((await save(owner, empty, "x")).status, 400);

    const drawn = await app.createBoard(owner);
    const client = await app.connect(owner);
    await client.join(drawn);
    await client.op(drawn, upsert(rect("z")));
    assert.equal((await save(owner, drawn, "x".repeat(61))).status, 400);
    assert.equal((await save(stranger, drawn, "mine now")).status, 403);
  });

  it("belong to one person, who can delete them", async () => {
    const owner = await app.signUp("Owner");
    const other = await app.signUp("Other");
    const id = await app.createBoard(owner);
    const client = await app.connect(owner);
    await client.join(id);
    await client.op(id, upsert(rect("z")));
    const { data } = await save(owner, id, "Private");

    assert.deepEqual((await app.request("/templates", { user: other })).data.templates, []);
    assert.equal((await app.request("/boards", { method: "POST", user: other, body: { templateId: data.template.id } })).status, 404);
    assert.equal((await app.request(`/templates/${data.template.id}`, { method: "DELETE", user: other })).status, 404);
    assert.equal((await app.request(`/templates/${data.template.id}`, { method: "DELETE", user: owner })).status, 204);
    assert.equal((await app.request(`/templates/${data.template.id}`, { method: "DELETE", user: owner })).status, 404);
  });

  it("are capped at 30 per person", async () => {
    const owner = await app.signUp("Owner");
    const id = await app.createBoard(owner);
    const client = await app.connect(owner);
    await client.join(id);
    await client.op(id, upsert(rect("z")));
    for (let index = 0; index < 30; index += 1) assert.equal((await save(owner, id, `T${index}`)).status, 201);
    assert.equal((await save(owner, id, "one more")).status, 400);
  });
});

describe("creating boards", () => {
  it("accepts drawings sent along (for example from a guest's scratch board) and drops anything invalid", async () => {
    const owner = await app.signUp("Owner");
    const elements = [rect("keep"), rect("keep"), { id: "bad", type: "unknown" }, null, rect("also-keep")];
    const { status, data } = await app.request("/boards", { method: "POST", user: owner, body: { title: "Imported", elements } });
    assert.equal(status, 201);
    assert.deepEqual(data.board.elements.map((element) => element.id), ["keep", "also-keep"]);
  });

  it("falls back to a default title and rejects a very long one", async () => {
    const owner = await app.signUp("Owner");
    assert.equal((await app.request("/boards", { method: "POST", user: owner, body: {} })).data.board.title, "Untitled board");
    assert.equal((await app.request("/boards", { method: "POST", user: owner, body: { title: "x".repeat(81) } })).status, 400);
  });
});
