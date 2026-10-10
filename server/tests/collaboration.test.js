import assert from "node:assert/strict";
import { after, before, describe, it } from "node:test";
import mongoose from "mongoose";
import { TEMPLATE_LIMITS } from "../src/controllers/template.controller.js";
import { Board } from "../src/models/board.model.ts";
import { Notification } from "../src/models/notification.model.ts";
import { Template } from "../src/models/template.model.ts";
import { Thread } from "../src/models/thread.model.ts";
import { Version } from "../src/models/version.model.ts";
import { elementBytes, MAX_ELEMENT_BYTES } from "../src/realtime/operations.js";
import { BOARD_LIMITS } from "../src/services/boards.ts";
import { pruneVersions, recordVersion, VERSION_LIMITS } from "../src/services/versions.ts";
import { eventually, rect, roundTrip, startServer, upsert } from "./helpers.js";

let app;
before(async () => {
  app = await startServer();
});
after(() => app.stop());

const invite = (owner, id, person) =>
  app.request(`/boards/${id}/collaborators`, { method: "POST", user: owner, body: { email: person.email } });
const setLink = (user, id, linkAccess) =>
  app.request(`/boards/${id}/link-access`, { method: "PATCH", user, body: { linkAccess } });

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

    const saved = await app.request(`/boards/${id}/versions`, {
      method: "POST",
      user: owner,
      body: { label: "  Milestone 1 " },
    });
    assert.equal(saved.status, 201);
    assert.equal(saved.data.version.label, "Milestone 1");
    assert.equal(saved.data.version.kind, "named");
    assert.equal(saved.data.version.elementCount, 1);
    assert.equal(saved.data.version.author.name, "Owner");

    const detail = await app.request(`/boards/${id}/versions/${saved.data.version.id}`, { user: owner });
    assert.deepEqual(
      detail.data.version.elements.map((element) => element.id),
      ["live-only"],
    );
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
    // Two saves in the same millisecond would have no order, so the first is dated a minute back.
    await Version.collection.updateOne(
      { board: new mongoose.Types.ObjectId(id), label: "first" },
      { $set: { createdAt: new Date(Date.now() - 60_000) } },
    );
    await save("second");
    const { data } = await app.request(`/boards/${id}/versions`, { user: owner });
    assert.deepEqual(
      data.versions.map((version) => version.label),
      ["second", "first"],
    );
    assert.equal(data.versions[0].elements, undefined);
  });

  it("restores an older version for everyone, after saving what was there so the restore can be undone", async () => {
    const { owner, editor, id } = await team();
    const ownerClient = await app.connect(owner);
    const editorClient = await app.connect(editor);
    await ownerClient.join(id);
    await editorClient.join(id);

    await ownerClient.op(id, upsert(rect("original")));
    const { data } = await app.request(`/boards/${id}/versions`, {
      method: "POST",
      user: owner,
      body: { label: "Good state" },
    });
    await editorClient.op(id, upsert(rect("regrettable")));

    const restored = await app.request(`/boards/${id}/versions/${data.version.id}/restore`, {
      method: "POST",
      user: editor,
    });
    assert.equal(restored.status, 200);
    assert.deepEqual(
      restored.data.elements.map((element) => element.id),
      ["original"],
    );

    const reset = await eventually(() => ownerClient.of("board:reset")[0], { message: "the reset broadcast" });
    assert.deepEqual(
      reset.elements.map((element) => element.id),
      ["original"],
    );
    assert.equal(reset.by, "Editor");

    const { data: history } = await app.request(`/boards/${id}/versions`, { user: owner });
    const safety = history.versions.find((version) => version.kind === "restore");
    assert.ok(safety, "the state before the restore was kept");
    assert.equal(safety.elementCount, 2);

    const rejoined = await (await app.connect(owner)).join(id);
    assert.deepEqual(
      rejoined.board.elements.map((element) => element.id),
      ["original"],
    );
  });

  it("takes an automatic checkpoint before a burst of work, but not again straight away", async () => {
    const { owner, id } = await team();
    const client = await app.connect(owner);
    await client.join(id);
    await client.op(id, upsert(rect("a")));
    await client.op(id, upsert(rect("b")));
    await client.op(id, upsert(rect("c")));

    const autos = await eventually(
      async () => {
        const { data } = await app.request(`/boards/${id}/versions`, { user: owner });
        const found = data.versions.filter((version) => version.kind === "auto");
        return found.length > 0 && found;
      },
      { message: "an automatic version" },
    );
    // The checkpoint is decided when the first change arrives, so all three changes have had their say by now.
    assert.equal(autos.length, 1);
    assert.equal(autos[0].elementCount, 1, "it holds the board as it was before the burst");
    const { data } = await app.request(`/boards/${id}/versions`, { user: owner });
    assert.equal(data.versions.filter((version) => version.kind === "auto").length, 1);
  });

  it("logs when an autosave is skipped because saved versions fill the history, instead of stopping silently", async () => {
    const { owner, id } = await team();
    await withVersionLimits({ bytes: 400_000 }, async () => {
      await recordVersion(id, drawing(300_000), { kind: "named", label: "Big", author: owner.id });
      // Long enough ago that a checkpoint is due, and a board that can't fit beside the saved version.
      await Version.collection.updateOne(
        { board: new mongoose.Types.ObjectId(id) },
        { $set: { createdAt: new Date(0) } },
      );
      await Board.updateOne({ _id: id }, { $set: { elements: drawing(200_000, "now") } });

      const warn = console.warn;
      const warnings = [];
      console.warn = (...args) => warnings.push(args.join(" "));
      try {
        const client = await app.connect(owner);
        await client.join(id);
        await client.op(id, upsert(rect("a")));
        await eventually(() => warnings.length > 0, { message: "a warning about the skipped autosave" });
        await client.op(id, upsert(rect("b")));
      } finally {
        console.warn = warn;
      }
      assert.equal(warnings.length, 1);
      assert.match(warnings[0], new RegExp(`board ${id}.*no room`));
      assert.equal(await Version.countDocuments({ board: id, kind: "auto" }), 0);
    });
  });

  it("keeps only the newest automatic versions but never prunes named ones", async () => {
    const { owner, id } = await team();
    await recordVersion(id, [rect("n")], { kind: "named", label: "Keep me", author: owner.id });
    for (let index = 0; index < 55; index += 1) await recordVersion(id, [rect(`e${index}`)], { kind: "auto" });
    assert.equal(await Version.countDocuments({ board: id, kind: "auto" }), 50);
    assert.equal(await Version.countDocuments({ board: id, kind: "named" }), 1);
  });

  it("trims the oldest autosaves to keep a board's history within its space, the newest going last", async () => {
    const { owner, id } = await team();
    await withVersionLimits({ bytes: 500_000 }, async () => {
      await recordVersion(id, drawing(200_000), { kind: "named", label: "Big keeper", author: owner.id });
      for (let index = 0; index < 8; index += 1)
        await recordVersion(id, drawing(60_000, `e${index}`), { kind: "auto" });

      const autos = await Version.find({ board: id, kind: "auto" }).sort({ createdAt: -1 }).lean();
      const total = (await Version.find({ board: id }).lean()).reduce((sum, version) => sum + version.bytes, 0);
      assert.ok(total <= 500_000, `history takes ${total} bytes`);
      assert.ok(autos.length >= 3 && autos.length < 8, `${autos.length} autosaves kept`);
      assert.equal(autos[0].elements[0].id, "e7", "the newest are the ones kept");
      assert.equal(await Version.countDocuments({ board: id, kind: "named" }), 1);

      // The budget holds even for big autosaves: a newer one pushes the older few out, and one
      // that can't fit beside the saved version is skipped rather than kept over budget.
      await recordVersion(id, drawing(250_000, "big"), { kind: "auto" });
      const left = await Version.find({ board: id, kind: "auto" }).lean();
      assert.deepEqual(
        left.map((version) => version.elements[0].id),
        ["big"],
      );
      assert.equal(await recordVersion(id, drawing(400_000, "huge"), { kind: "auto" }), null);
      assert.equal(await Version.countDocuments({ board: id, kind: "auto" }), 1);
    });
  });

  it("keeps only the newest before-restore snapshots", async () => {
    const { id } = await team();
    await withVersionLimits({ restore: 2 }, async () => {
      for (let index = 0; index < 4; index += 1) await recordVersion(id, [rect(`r${index}`)], { kind: "restore" });
      const kept = await Version.find({ board: id, kind: "restore" }).sort({ createdAt: -1 }).lean();
      assert.deepEqual(
        kept.map((version) => version.elements[0].id),
        ["r3", "r2"],
      );
    });
  });

  it("measures versions saved before sizes were recorded", async () => {
    const { id } = await team();
    const old = await Version.collection.insertOne({
      board: new mongoose.Types.ObjectId(id),
      kind: "auto",
      elements: drawing(10_000),
      elementCount: 1,
      createdAt: new Date(0),
    });
    await pruneVersions(id);
    const measured = await Version.findById(old.insertedId).lean();
    assert.ok(measured.bytes > 5_000, `measured ${measured.bytes} bytes`);
  });

  it("lists every version a board can keep, not just the newest hundred", async () => {
    const { owner, id } = await team();
    await Version.insertMany(
      Array.from({ length: 105 }, (_, index) => ({ board: id, kind: "named", label: `V${index}`, elements: [] })),
    );
    const { data } = await app.request(`/boards/${id}/versions`, { user: owner });
    assert.equal(data.versions.length, 105);
  });

  it("holds saved versions to the count even when the saves arrive at the same moment", async () => {
    const { owner, id } = await team();
    const save = (label) => app.request(`/boards/${id}/versions`, { method: "POST", user: owner, body: { label } });
    await withVersionLimits({ named: 2 }, async () => {
      const results = await Promise.all(["a", "b", "c", "d", "e"].map(save));
      assert.equal(results.filter((result) => result.status === 201).length, 2);
      assert.equal(await Version.countDocuments({ board: id, kind: "named" }), 2);
    });
  });

  it("makes room for a saved version by dropping autosaves, and refuses only when saved versions alone fill the space", async () => {
    const { owner, id } = await team();
    const save = (label) => app.request(`/boards/${id}/versions`, { method: "POST", user: owner, body: { label } });
    await withVersionLimits({ bytes: 500_000 }, async () => {
      for (let index = 0; index < 3; index += 1)
        await recordVersion(id, drawing(100_000, `a${index}`), { kind: "auto" });
      await Board.updateOne({ _id: id }, { $set: { elements: drawing(150_000) } });
      // No saved version yet, and the autosaves (which nobody can delete) are in the way: they give way.
      assert.equal((await save("one")).status, 201); // 300k of autosaves + 150k
      assert.equal((await save("two")).status, 201); // 300k + 300k is over 500k: the oldest autosave goes
      const autos = await Version.find({ board: id, kind: "auto" }).sort({ createdAt: -1 }).lean();
      assert.equal(autos[0].elements[0].id, "a2", "the newest autosave is kept while it fits");
      assert.equal((await save("three")).status, 201); // 450k of saved versions
      const refused = await save("does not fit"); // 600k of saved versions
      assert.equal(refused.status, 400);
      assert.match(refused.data.error, /saved versions use up its history space.*Delete an older saved version/);
      assert.equal(await Version.countDocuments({ board: id, kind: "named" }), 3);
    });
  });

  it("measures old versions the way new ones are measured", async () => {
    const { id } = await team();
    const elements = drawing(10_000);
    const old = await Version.collection.insertOne({
      board: new mongoose.Types.ObjectId(id),
      kind: "auto",
      elements,
      elementCount: 1,
      createdAt: new Date(0),
    });
    await pruneVersions(id);
    const { bytes } = await recordVersion(id, elements, { kind: "auto" });
    assert.equal((await Version.findById(old.insertedId).lean()).bytes, bytes);
  });

  it("refuses a name that isn't text", async () => {
    const { owner, id } = await team();
    for (const label of [{ a: 1 }, 5, ["x"]]) {
      const result = await app.request(`/boards/${id}/versions`, { method: "POST", user: owner, body: { label } });
      assert.equal(result.status, 400);
    }
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
      assert.match(refused.data.error, /saved versions use up its history space/);
    });
  });

  it("lets members delete saved versions, but not autosaves, and not anyone else", async () => {
    const { owner, editor, id } = await team();
    const viewer = await app.signUp("Viewer");
    await setLink(owner, id, "view");
    const { data } = await app.request(`/boards/${id}/versions`, {
      method: "POST",
      user: owner,
      body: { label: "Old idea" },
    });
    const auto = await recordVersion(id, [rect("a")], { kind: "auto" });
    const remove = (user, versionId) => app.request(`/boards/${id}/versions/${versionId}`, { method: "DELETE", user });

    assert.equal((await remove(viewer, data.version.id)).status, 403);
    assert.equal((await remove(editor, auto.id)).status, 400);
    assert.equal((await remove(editor, data.version.id)).status, 204);
    assert.equal((await remove(editor, data.version.id)).status, 404);
    const { data: history } = await app.request(`/boards/${id}/versions`, { user: owner });
    assert.deepEqual(
      history.versions.map((version) => version.kind),
      ["auto"],
    );
  });

  it("is for members only, and a version can only be fetched through its own board", async () => {
    const { owner, id } = await team();
    const viewer = await app.signUp("Viewer");
    const otherId = await app.createBoard(owner, "Other");
    await setLink(owner, id, "view");
    const { data } = await app.request(`/boards/${id}/versions`, { method: "POST", user: owner, body: { label: "v" } });

    assert.equal((await app.request(`/boards/${id}/versions`, { user: viewer })).status, 403);
    assert.equal(
      (await app.request(`/boards/${id}/versions`, { method: "POST", user: viewer, body: { label: "x" } })).status,
      403,
    );
    assert.equal(
      (await app.request(`/boards/${id}/versions/${data.version.id}/restore`, { method: "POST", user: viewer })).status,
      403,
    );
    assert.equal((await app.request(`/boards/${otherId}/versions/${data.version.id}`, { user: owner })).status, 404);
    assert.equal((await app.request(`/boards/${id}/versions/not-an-id`, { user: owner })).status, 404);
  });
});

describe("comments", () => {
  const comment = (user, id, body) => app.request(`/boards/${id}/threads`, { method: "POST", user, body });

  it("lets editors start a thread pinned to the canvas, and mention members", async () => {
    const { owner, editor, id } = await team();
    const { status, data } = await comment(editor, id, {
      x: 120,
      y: -40,
      body: "  Looks off @Owner ",
      mentions: [owner.id],
    });
    assert.equal(status, 201);
    assert.equal(data.thread.x, 120);
    assert.equal(data.thread.messages[0].body, "Looks off @Owner");
    assert.deepEqual(
      data.thread.messages[0].mentions.map((person) => person.id),
      [owner.id],
    );

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
    assert.deepEqual(
      own.map((n) => n.type),
      ["invite"],
      "the author isn't notified about their own comment",
    );

    const reply = await app.request(`/boards/${id}/threads/${threadId}/messages`, {
      method: "POST",
      user: owner,
      body: { body: "answer" },
    });
    assert.equal(reply.status, 201);
    assert.equal(reply.data.thread.messages.length, 2);
    const forEditor = (await app.request("/notifications", { user: editor })).data.notifications;
    assert.deepEqual(
      forEditor.map((n) => n.type).sort(),
      ["invite", "reply"],
      "a reply notification, on top of the earlier invite",
    );
  });

  it("doesn't tell people who can no longer open the board about replies, or show them its comments", async () => {
    const { owner, editor, id } = await team();
    const { data } = await comment(editor, id, { x: 0, y: 0, body: "private plans" });
    const reply = (body) =>
      app.request(`/boards/${id}/threads/${data.thread.id}/messages`, { method: "POST", user: owner, body: { body } });
    assert.equal((await reply("first")).status, 201);
    assert.equal((await app.request("/notifications", { user: editor })).data.notifications.length, 2); // invite, reply

    assert.equal(
      (await app.request(`/boards/${id}/collaborators/${editor.id}`, { method: "DELETE", user: owner })).status,
      200,
    );
    assert.equal((await reply("secret follow-up")).status, 201);

    const seen = (await app.request("/notifications", { user: editor })).data;
    assert.deepEqual(seen.notifications, [], "nothing about a board they can't open, not even its title");
    assert.equal(seen.unread, 0);
    assert.equal(await Notification.countDocuments({ user: editor.id, excerpt: /secret/ }), 0);
  });

  it("still tells people who can open the board through its link", async () => {
    const { owner, editor, id } = await team();
    const { data } = await comment(editor, id, { x: 0, y: 0, body: "hello" });
    await setLink(owner, id, "view");
    await app.request(`/boards/${id}/collaborators/${editor.id}`, { method: "DELETE", user: owner });
    await app.request(`/boards/${id}/threads/${data.thread.id}/messages`, {
      method: "POST",
      user: owner,
      body: { body: "reply" },
    });
    const types = (await app.request("/notifications", { user: editor })).data.notifications.map((n) => n.type);
    assert.ok(types.includes("reply"));
  });

  it("keeps a thread's message count, position and text within bounds", async () => {
    const { owner, id } = await team();
    for (const body of [
      { x: 1e9, y: 0, body: "far away" },
      { x: "12", y: 0, body: "text, not a number" },
      { x: 0, y: 0, body: { not: "text" } },
      { x: 0, y: 0, body: ["x"] },
    ]) {
      assert.equal((await comment(owner, id, body)).status, 400, JSON.stringify(body));
    }
    const { data } = await comment(owner, id, { x: 0, y: 0, body: "ok" });
    const url = `/boards/${id}/threads/${data.thread.id}`;
    assert.equal((await app.request(url, { method: "PATCH", user: owner, body: { x: 1e9 } })).status, 400);

    await Thread.updateOne(
      { _id: data.thread.id },
      { $set: { messages: Array.from({ length: 200 }, () => ({ author: owner.id, body: "again" })) } },
    );
    const full = await app.request(`${url}/messages`, { method: "POST", user: owner, body: { body: "one too many" } });
    assert.equal(full.status, 400);
    assert.match(full.data.error, /200 messages/);
  });

  it("shows the same one-line excerpt for a new thread as for a reply", async () => {
    const { owner, editor, id } = await team();
    await comment(editor, id, { x: 0, y: 0, body: "line one\n\n   line   two", mentions: [owner.id] });
    const [mention] = (await app.request("/notifications", { user: owner })).data.notifications;
    assert.equal(mention.excerpt, "line one line two");
  });

  it("takes a thread's notifications away when the thread is deleted", async () => {
    const { owner, editor, id } = await team();
    const { data } = await comment(editor, id, { x: 0, y: 0, body: "look", mentions: [owner.id] });
    assert.equal((await app.request("/notifications", { user: owner })).data.unread, 1);
    await app.request(`/boards/${id}/threads/${data.thread.id}`, { method: "DELETE", user: editor });
    assert.equal(await Notification.countDocuments({ thread: data.thread.id }), 0);
    assert.equal((await app.request("/notifications", { user: owner })).data.unread, 0);
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
    await roundTrip(guest);
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

    assert.equal(
      (
        await app.request("/notifications/read", {
          method: "POST",
          user: person,
          body: { ids: [data.notifications[0].id, "bad"] },
        })
      ).status,
      204,
    );
    assert.equal((await app.request("/notifications", { user: person })).data.unread, 2);
    assert.equal((await app.request("/notifications/read", { method: "POST", user: person, body: {} })).status, 204);
    assert.equal((await app.request("/notifications", { user: person })).data.unread, 0);
  });

  it("aren't piled up when the same person is invited again before the first one is read", async () => {
    const owner = await app.signUp("Owner");
    const person = await app.signUp("Person");
    const id = await app.createBoard(owner, "Again and again");
    for (let round = 0; round < 3; round += 1) {
      await invite(owner, id, person);
      await app.request(`/boards/${id}/collaborators/${person.id}`, { method: "DELETE", user: owner });
    }
    await invite(owner, id, person);
    const { data } = await app.request("/notifications", { user: person });
    assert.equal(data.notifications.length, 1);
    assert.equal(data.unread, 1);
  });

  it("are listed thirty at a time, newest first, and count only what the list can show", async () => {
    const person = await app.signUp("Person");
    for (let index = 0; index < 32; index += 1) {
      const owner = await app.signUp("Inviter");
      await invite(owner, await app.createBoard(owner, `Board ${index}`), person);
    }
    const first = (await app.request("/notifications", { user: person })).data;
    assert.equal(first.notifications.length, 30);
    assert.equal(first.more, true);
    assert.equal(first.unread, 32);
    assert.equal(first.notifications[0].board.title, "Board 31");

    const last = first.notifications.at(-1).id;
    const second = (await app.request(`/notifications?before=${last}`, { user: person })).data;
    assert.deepEqual(
      second.notifications.map((n) => n.board.title),
      ["Board 1", "Board 0"],
    );
    assert.equal(second.more, false);
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
    assert.equal(made.data.template.elementCount, 2);
    assert.equal((await app.request("/templates", { user: owner })).data.templates.length, 1);

    const fromTemplate = await app.request("/boards", {
      method: "POST",
      user: owner,
      body: { templateId: made.data.template.id },
    });
    assert.equal(fromTemplate.status, 201);
    assert.equal(fromTemplate.data.board.title, "Retro", "the template's name is the default title");
    assert.deepEqual(
      fromTemplate.data.board.elements.map((element) => element.id),
      ["t1", "t2"],
    );
  });

  it("are listed as light previews, without their drawings", async () => {
    const owner = await app.signUp("Owner");
    const id = await app.createBoard(owner);
    const client = await app.connect(owner);
    await client.join(id);
    await client.op(id, upsert(rect("a"), rect("b")));
    const made = await save(owner, id, "Light");

    const [listed] = (await app.request("/templates", { user: owner })).data.templates;
    assert.equal(listed.id, made.data.template.id);
    assert.equal(listed.elementCount, 2);
    assert.deepEqual(
      listed.preview.map((element) => element.id),
      ["a", "b"],
    );
    assert.equal(listed.elements, undefined);
    assert.equal(made.data.template.elements, undefined);
  });

  it("saved before previews existed get theirs the first time they're listed", async () => {
    const owner = await app.signUp("Owner");
    const old = await Template.collection.insertOne({
      owner: new mongoose.Types.ObjectId(owner.id),
      title: "Old",
      elements: [rect("x"), rect("y"), rect("z")],
      createdAt: new Date(),
      updatedAt: new Date(),
    });
    const [listed] = (await app.request("/templates", { user: owner })).data.templates;
    assert.equal(listed.elementCount, 3);
    assert.equal(listed.preview.length, 3);
    const stored = await Template.collection.findOne({ _id: old.insertedId });
    assert.equal(stored.elementCount, 3, "and it is kept, so this happens once");
  });

  it("take their name from a long board title, cut to fit", async () => {
    const owner = await app.signUp("Owner");
    const id = await app.createBoard(owner, "T".repeat(75));
    const client = await app.connect(owner);
    await client.join(id);
    await client.op(id, upsert(rect("z")));
    const made = await save(owner, id);
    assert.equal(made.status, 201);
    assert.equal(made.data.template.title, "T".repeat(60));
    assert.equal((await save(owner, id, { not: "text" })).status, 400);
  });

  it("let go of arrows that were attached to a picture they left out", async () => {
    const owner = await app.signUp("Owner");
    const id = await app.createBoard(owner);
    const client = await app.connect(owner);
    await client.join(id);
    const imageId = "a".repeat(32);
    await client.op(
      id,
      upsert(
        rect("box"),
        { id: "pic", type: "image", imageId, x1: 300, y1: 0, x2: 400, y2: 100 },
        {
          id: "arrow",
          type: "arrow",
          x1: 100,
          y1: 30,
          x2: 300,
          y2: 50,
          stroke: "#16213a",
          strokeWidth: 2.5,
          startId: "box",
          startAnchor: "right",
          endId: "pic",
          endAnchor: "left",
        },
      ),
    );
    const made = await save(owner, id, "Arrows");
    assert.equal(made.status, 201);
    const stored = await Template.findById(made.data.template.id).lean();
    const arrow = stored.elements.find((element) => element.id === "arrow");
    assert.equal(arrow.startId, "box", "still attached to the box that stayed");
    assert.equal(arrow.endId, undefined);
    assert.equal(arrow.endAnchor, undefined);
    assert.equal(arrow.x2, 300, "and still drawn where it ended");
  });

  it("refuse a board too big to keep, however many are saved", async () => {
    const owner = await app.signUp("Owner");
    const id = await app.createBoard(owner);
    await Board.updateOne({ _id: id }, { $set: { elements: drawing(300_000) } });
    const saved = { ...TEMPLATE_LIMITS };
    try {
      Object.assign(TEMPLATE_LIMITS, { bytes: 100_000 });
      const refused = await save(owner, id, "Huge");
      assert.equal(refused.status, 400);
      assert.match(refused.data.error, /too big/);
      Object.assign(TEMPLATE_LIMITS, { bytes: 1_000_000 });
      assert.equal((await save(owner, id, "Fits")).status, 201);
    } finally {
      Object.assign(TEMPLATE_LIMITS, saved);
    }
  });

  it("only keep elements a board could hold: invalid or repeated ones, and ones too big to store, are left out", async () => {
    const owner = await app.signUp("Owner");
    const id = await app.createBoard(owner);
    const huge = {
      id: "huge",
      type: "pen",
      points: Array.from({ length: 40_000 }, (_, i) => [i + 0.25, i + 0.5, 0.5]),
      pressure: false,
      stroke: "#16213a",
      penSize: 8,
    };
    await Board.updateOne(
      { _id: id },
      { $set: { elements: [rect("ok"), { id: "bad", type: "unknown" }, rect("ok"), huge, null] } },
    );
    const made = await save(owner, id, "Clean");
    assert.equal(made.status, 201);
    const stored = await Template.findById(made.data.template.id).lean();
    assert.equal(stored.elements.filter((element) => element.id === "ok").length, 1);
    assert.ok(stored.elements.every((element) => element.id !== "bad"));
    assert.ok(stored.elements.every((element) => elementBytes(element) <= MAX_ELEMENT_BYTES));
  });

  it("stay within the cap when saves arrive at the same moment", async () => {
    const owner = await app.signUp("Owner");
    const id = await app.createBoard(owner);
    await Board.updateOne({ _id: id }, { $set: { elements: [rect("z")] } });
    const saved = { ...TEMPLATE_LIMITS };
    try {
      Object.assign(TEMPLATE_LIMITS, { count: 2 });
      const results = await Promise.all(["a", "b", "c", "d", "e"].map((title) => save(owner, id, title)));
      assert.equal(results.filter((result) => result.status === 201).length, 2);
      assert.equal(await Template.countDocuments({ owner: owner.id }), 2);
    } finally {
      Object.assign(TEMPLATE_LIMITS, saved);
    }
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
    assert.equal(
      (await app.request("/boards", { method: "POST", user: other, body: { templateId: data.template.id } })).status,
      404,
    );
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
    const { status, data } = await app.request("/boards", {
      method: "POST",
      user: owner,
      body: { title: "Imported", elements },
    });
    assert.equal(status, 201);
    assert.deepEqual(
      data.board.elements.map((element) => element.id),
      ["keep", "also-keep"],
    );
  });

  it("limits how many boards one person has, trashed ones included", async () => {
    const owner = await app.signUp("Owner");
    const other = await app.signUp("Other");
    const create = (user) => app.request("/boards", { method: "POST", user, body: {} });
    const saved = { ...BOARD_LIMITS };
    try {
      Object.assign(BOARD_LIMITS, { perOwner: 2 });
      const first = await create(owner);
      assert.equal(first.status, 201);
      assert.equal((await create(owner)).status, 201);
      const refused = await create(owner);
      assert.equal(refused.status, 400);
      assert.match(refused.data.error, /2 boards/);

      await app.request(`/boards/${first.data.board.id}`, { method: "DELETE", user: owner });
      assert.equal((await create(owner)).status, 400, "a board in the trash still takes its place");
      await app.request(`/boards/${first.data.board.id}/permanent`, { method: "DELETE", user: owner });
      assert.equal((await create(owner)).status, 201, "erasing it makes room");
      assert.equal((await create(other)).status, 201, "and it is per person");
    } finally {
      Object.assign(BOARD_LIMITS, saved);
    }
  });

  it("limits the space one person's boards take, counting what a new board starts with", async () => {
    const owner = await app.signUp("Owner");
    const saved = { ...BOARD_LIMITS };
    try {
      Object.assign(BOARD_LIMITS, { ownerBytes: 400_000 });
      const create = (elements) =>
        app.request("/boards", { method: "POST", user: owner, body: { elements, title: "Big" } });
      assert.equal((await create(drawing(150_000, "a"))).status, 201);
      assert.equal((await create(drawing(150_000, "b"))).status, 201);
      const refused = await create(drawing(150_000, "c"));
      assert.equal(refused.status, 400);
      assert.match(refused.data.error, /used up their space/);
      assert.equal((await app.request("/boards", { method: "POST", user: owner, body: {} })).status, 201);
    } finally {
      Object.assign(BOARD_LIMITS, saved);
    }
  });

  it("falls back to a default title and rejects a very long one", async () => {
    const owner = await app.signUp("Owner");
    assert.equal(
      (await app.request("/boards", { method: "POST", user: owner, body: {} })).data.board.title,
      "Untitled board",
    );
    assert.equal(
      (await app.request("/boards", { method: "POST", user: owner, body: { title: "x".repeat(81) } })).status,
      400,
    );
  });

  it("takes a title only as text, never as an object turned into words", async () => {
    const owner = await app.signUp("Owner");
    for (const title of [{ a: 1 }, ["x"], 5]) {
      assert.equal((await app.request("/boards", { method: "POST", user: owner, body: { title } })).status, 400);
    }
    const id = await app.createBoard(owner);
    const rename = (title) => app.request(`/boards/${id}`, { method: "PATCH", user: owner, body: { title } });
    assert.equal((await rename({ a: 1 })).status, 400);
    assert.equal((await rename("Fine")).status, 200);
  });
});
