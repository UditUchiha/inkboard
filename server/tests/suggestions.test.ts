import assert from "node:assert/strict";
import { after, before, describe, it } from "node:test";
import { MAX_SUGGESTIONS_PER_AUTHOR } from "@inkboard/shared/limits";
import type { ChangeSuggestion } from "@inkboard/shared/suggestions";
import type { ShapeElement } from "@inkboard/shared/types";
import { Board } from "../src/models/board.model.ts";
import { getSession } from "../src/realtime/sessions.ts";
import { eventually, rect, remove, roundTrip, startServer, upsert } from "./helpers.ts";
import type { ServerInstance, TestClient, TestUser } from "./helpers.ts";

let app: ServerInstance;
before(async () => {
  app = await startServer();
});
after(() => app.stop());

const setLink = (user: TestUser, boardId: string, linkAccess: string) =>
  app.request(`/boards/${boardId}/link-access`, { method: "PATCH", user, body: { linkAccess } });

// A board shared with a "suggest" link and a rectangle on it, its owner on it, and a guest who joined by the link.
async function suggestBoard() {
  const owner = await app.signUp("Owner");
  const boardId = await app.createBoard(owner);
  assert.equal((await setLink(owner, boardId, "suggest")).status, 200);
  const host = await app.connect(owner);
  await host.join(boardId);
  assert.equal((await host.op(boardId, upsert(rect("box")))).ok, true);
  const guest = await app.connect(null, { guest: { id: "g_suggester1", name: "Sam" } });
  const joined = await guest.join(boardId);
  return { owner, boardId, host, guest, joined };
}

// What `client` has heard of suggestions: the ones made or changed, and the ones that went (with why).
const upserted = (client: TestClient) => client.of("suggestion:upsert").flatMap((message) => message.suggestions);
const deleted = (client: TestClient) => client.of("suggestion:delete");

describe("a suggest link", () => {
  it("lets people open the board as suggesters, who can't change it directly", async () => {
    const { boardId, guest, joined } = await suggestBoard();
    assert.equal(joined.ok, true);
    assert.equal(joined.board.role, "suggester");
    assert.deepEqual(joined.suggestions, []);
    const refused = await guest.op(boardId, upsert(rect("mine")));
    assert.equal(refused.ok, false);
    assert.equal(refused.reason, "forbidden");
  });

  it("only takes suggestions from suggesters: not members or people on an edit link", async () => {
    const { owner, boardId, host } = await suggestBoard();
    assert.equal((await host.suggest(boardId, [{ kind: "add", element: rect("a") }])).reason, "forbidden");
    await setLink(owner, boardId, "edit");
    const contributor = await app.connect(null);
    await contributor.join(boardId);
    assert.equal((await contributor.suggest(boardId, [{ kind: "add", element: rect("b") }])).reason, "forbidden");
  });
});

describe("making suggestions", () => {
  it("keeps a new element as an addition, shows it to everyone on the board, and to people who join later", async () => {
    const { boardId, host, guest } = await suggestBoard();
    const reply = await guest.suggest(boardId, [{ kind: "add", element: rect("idea", 300, 0) }]);
    assert.equal(reply.ok, true);
    const [made] = reply.suggestions!;
    assert.equal(made!.id, "add:idea");
    assert.equal(made!.kind, "add");
    assert.equal(made!.author.name, "Sam");
    assert.equal(made!.author.guest, true);
    assert.equal("version" in (made as { element: object }).element, false, "no stamps: it isn't on the board");

    await eventually(() => upserted(host).some((suggestion) => suggestion.id === "add:idea"));
    const later = await (await app.connect(null)).join(boardId);
    assert.deepEqual(
      later.suggestions.map((suggestion) => suggestion.id),
      ["add:idea"],
    );
    const board = getSession(boardId)!;
    assert.equal(board.index.has("idea"), false, "the board itself is unchanged");
  });

  it("keeps a changed element as a change of only the groups that differ, with their stamps", async () => {
    const { boardId, host, guest } = await suggestBoard();
    const reply = await guest.suggest(boardId, [{ kind: "change", element: { ...rect("box"), stroke: "#e03131" } }]);
    const change = reply.suggestions![0] as ChangeSuggestion;
    assert.equal(change.id, "on:g_suggester1:box");
    assert.equal(change.target, "box");
    assert.deepEqual(change.groups, ["stroke"]);
    assert.deepEqual(Object.keys(change.base), ["stroke"]);
    const onBoard = getSession(boardId)!.index.get("box") as ShapeElement;
    assert.equal(onBoard.stroke, "#16213a", "the board keeps its color");

    // Changing it again replaces the suggestion; putting it back as it was takes it back.
    const moved = await guest.suggest(boardId, [
      { kind: "change", element: { ...rect("box", 40, 0), stroke: "#e03131" } },
    ]);
    assert.deepEqual((moved.suggestions![0] as ChangeSuggestion).groups, ["shape", "stroke"]);
    assert.equal(moved.suggestions![0]!.createdAt, change.createdAt);
    const undone = await guest.suggest(boardId, [{ kind: "change", element: rect("box") }]);
    assert.deepEqual(undone.suggestions, []);
    await eventually(() => deleted(host).some((message) => message.outcome === "withdrawn"));
    assert.equal(getSession(boardId)!.suggestions.byId.size, 0);
  });

  it("keeps a removal, and turns the author's change of the same element into one", async () => {
    const { boardId, guest } = await suggestBoard();
    await guest.suggest(boardId, [{ kind: "change", element: { ...rect("box"), fill: "#ffd43b" } }]);
    const reply = await guest.suggest(boardId, [{ kind: "remove", target: "box" }]);
    assert.equal(reply.suggestions![0]!.kind, "remove");
    const open = [...getSession(boardId)!.suggestions.byId.values()];
    assert.deepEqual(
      open.map((suggestion) => [suggestion.id, suggestion.kind]),
      [["on:g_suggester1:box", "remove"]],
    );
  });

  it("leaves out drafts it can't take, and says which", async () => {
    const { boardId, guest } = await suggestBoard();
    const reply = await guest.suggest(boardId, [
      { kind: "add", element: rect("box") }, // already on the board
      { kind: "add", element: { id: "pic", type: "image", imageId: "x", x1: 0, y1: 0, x2: 10, y2: 10 } },
      { kind: "change", element: rect("nowhere") },
      { kind: "remove", target: "nowhere-else" },
      { kind: "add", element: { id: "broken", type: "rectangle" } },
      { kind: "made-up", element: rect("odd") },
      null,
      { kind: "add", element: rect("fine") },
    ]);
    assert.equal(reply.ok, true);
    assert.deepEqual(
      reply.suggestions!.map((suggestion) => suggestion.id),
      ["add:fine"],
    );
    assert.deepEqual(reply.dropped, ["box", "pic", "nowhere", "nowhere-else", "broken", "odd"]);
    assert.equal((await guest.suggest(boardId, "not a list")).reason, "invalid");
    assert.equal((await guest.suggest("another-board", [])).reason, "noSession");
  });

  it("won't let one person replace or withdraw another's suggestions", async () => {
    const { boardId, guest } = await suggestBoard();
    await guest.suggest(boardId, [{ kind: "add", element: rect("sams") }]);
    const other = await app.connect(null, { guest: { id: "g_someoneelse", name: "Kim" } });
    await other.join(boardId);
    const replaced = await other.suggest(boardId, [{ kind: "add", element: rect("sams", 500, 500) }]);
    assert.deepEqual(replaced.dropped, ["sams"]);
    await other.withdraw(boardId, ["add:sams"]);
    assert.equal(getSession(boardId)!.suggestions.byId.get("add:sams")!.author.name, "Sam");

    assert.equal((await guest.withdraw(boardId, ["add:sams"])).ok, true);
    assert.equal(getSession(boardId)!.suggestions.byId.size, 0);
    await eventually(() => deleted(other).some((message) => message.ids.includes("add:sams")));
  });

  it("stops at what one person may have open", async () => {
    const { boardId, guest } = await suggestBoard();
    const many = Array.from({ length: MAX_SUGGESTIONS_PER_AUTHOR + 2 }, (_, i) => ({
      kind: "add",
      element: rect(`n${i}`, i * 10, 0),
    }));
    const reply = await guest.suggest(boardId, many);
    assert.equal(reply.suggestions!.length, MAX_SUGGESTIONS_PER_AUTHOR);
    assert.equal(reply.full, "author");
    assert.deepEqual(reply.dropped, [`n${MAX_SUGGESTIONS_PER_AUTHOR}`, `n${MAX_SUGGESTIONS_PER_AUTHOR + 1}`]);
    // Changing one already open is still fine.
    const again = await guest.suggest(boardId, [{ kind: "add", element: rect("n0", 999, 0) }]);
    assert.equal(again.suggestions!.length, 1);
  });
});

describe("deciding on suggestions", () => {
  it("lets members reject them, and nobody else", async () => {
    const { boardId, host, guest } = await suggestBoard();
    await guest.suggest(boardId, [{ kind: "add", element: rect("meh") }]);
    assert.equal((await guest.resolve(boardId, ["add:meh"], "rejected")).reason, "forbidden");
    assert.equal((await host.resolve(boardId, ["add:meh"], "maybe")).reason, "invalid");
    assert.equal((await host.resolve(boardId, ["add:meh"], "rejected")).ok, true);
    assert.equal(getSession(boardId)!.suggestions.byId.size, 0);
    await eventually(() => deleted(guest).find((message) => message.outcome === "rejected"));
    assert.deepEqual(deleted(guest).at(-1)!.ids, ["add:meh"]);
  });

  it("counts a suggested element put on the board as accepted, and drops suggestions about an element that went", async () => {
    const { boardId, host, guest } = await suggestBoard();
    await host.op(boardId, upsert(rect("other", 500, 0)));
    await guest.suggest(boardId, [
      { kind: "add", element: rect("idea", 300, 0) },
      { kind: "change", element: rect("other", 600, 0) },
      { kind: "remove", target: "box" },
    ]);

    // Accepting the addition is the member putting the same element on the board.
    await host.op(boardId, upsert(rect("idea", 300, 0)));
    await eventually(() => deleted(guest).find((message) => message.ids.includes("add:idea")));
    assert.equal(deleted(guest).at(-1)!.outcome, "accepted");

    // Removing what a removal is about carries it out; a change to it has nothing left to change.
    await host.op(boardId, remove("box", "other"));
    await eventually(() => getSession(boardId)!.suggestions.byId.size === 0);
    await roundTrip(guest);
    const outcomes = Object.fromEntries(
      deleted(guest).flatMap((message) => message.ids.map((id) => [id, message.outcome])),
    );
    assert.equal(outcomes["on:g_suggester1:box"], "accepted");
    assert.equal(outcomes["on:g_suggester1:other"], "gone");
  });
});

describe("keeping suggestions", () => {
  it("saves them with the board, so they're there when it's opened again", async () => {
    const { boardId, host, guest } = await suggestBoard();
    await guest.suggest(boardId, [{ kind: "add", element: rect("kept") }]);
    host.close();
    guest.close();
    await eventually(() => !getSession(boardId), { message: "the board to close" });

    const back = await (await app.connect(null)).join(boardId);
    assert.deepEqual(
      back.suggestions.map((suggestion) => suggestion.id),
      ["add:kept"],
    );
  });

  it("lets go of suggestions about elements that went while the board was closed", async () => {
    const { boardId, host, guest } = await suggestBoard();
    await guest.suggest(boardId, [
      { kind: "change", element: rect("box", 70, 0) },
      { kind: "add", element: rect("still-new") },
    ]);
    host.close();
    guest.close();
    await eventually(() => !getSession(boardId), { message: "the board to close" });
    // As a version restore (or anything else that rewrites the drawing) might leave it.
    await Board.updateOne({ _id: boardId }, { $set: { elements: [] } });

    const back = await (await app.connect(null)).join(boardId);
    assert.deepEqual(
      back.suggestions.map((suggestion) => suggestion.id),
      ["add:still-new"],
    );
  });

  it("keeps them when the link stops allowing suggestions, while their authors can no longer add more", async () => {
    const { owner, boardId, guest } = await suggestBoard();
    await guest.suggest(boardId, [{ kind: "add", element: rect("before") }]);
    await setLink(owner, boardId, "view");
    await eventually(() => guest.last("board:role")?.role === "viewer");
    assert.equal((await guest.suggest(boardId, [{ kind: "add", element: rect("after") }])).reason, "forbidden");
    assert.equal(getSession(boardId)!.suggestions.byId.has("add:before"), true);
  });
});
