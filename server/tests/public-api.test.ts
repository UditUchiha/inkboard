import assert from "node:assert/strict";
import { after, before, describe, it } from "node:test";
import type { ApiTokenCreatedReply, ApiTokenListReply } from "@inkboard/shared/api";
import type { Element, ShapeElement } from "@inkboard/shared/types";
import { Board } from "../src/models/board.model.ts";
import { fromApiElement, toApiElement } from "../src/services/api-elements.ts";
import type { ApiElement } from "../src/services/api-elements.ts";
import { eventually, rect, startServer } from "./helpers.ts";
import type { ServerInstance, TestUser } from "./helpers.ts";

let app: ServerInstance;
before(async () => {
  app = await startServer();
});
after(() => app.stop());

const none = () => undefined;

describe("API elements", () => {
  it("show boxes as x, y, width and height, and lines by what they're attached to", () => {
    const shown = toApiElement({ ...rect("a", 10, 20), index: "a0", version: 3, versionNonce: 1 } as Element);
    assert.deepEqual([shown.x, shown.y, shown.width, shown.height], [10, 20, 100, 60]);
    assert.equal("x1" in shown || "index" in shown || "version" in shown || "seed" in shown, false);
  });

  it("make an arrow between two shapes, starting from their middles", () => {
    const a = fromApiElement({ id: "a", type: "rectangle", x: 0, y: 0, width: 100, height: 50 }, undefined, none, "1");
    const b = fromApiElement({ id: "b", type: "ellipse", x: 300, y: 0, width: 100, height: 50 }, undefined, none, "2");
    const found = new Map([a, b].map((element) => [element.id, element]));
    const arrow = fromApiElement({ type: "arrow", from: "a", to: "b" }, undefined, (id) => found.get(id), "3");
    assert.deepEqual(toApiElement(arrow).from, "a");
    assert.deepEqual([(arrow as ShapeElement).x1, (arrow as ShapeElement).x2], [50, 350]);
  });

  it("change only the fields given, as the newest edit, and keep the type", () => {
    const stamped = { ...rect("a", 0, 0), version: 9, versionNonce: 4, stroke: "#e03131" } as Element;
    const moved = fromApiElement({ id: "a", x: 40 }, stamped, none, "1") as ShapeElement;
    assert.deepEqual([moved.x1, moved.y1, moved.x2, moved.stroke], [40, 0, 140, "#e03131"]);
    assert.equal(moved.version, undefined, "unstamped, so the board stamps it as the newest edit");
    assert.throws(() => fromApiElement({ id: "a", type: "ellipse" }, stamped, none, "Element 1"), /type can't change/);
    assert.throws(() => fromApiElement({ type: "rectangle", x: 1 }, undefined, none, "Element 2"), /^Error: Element 2/);
  });
});

async function makeToken(user: TestUser, scope: "read" | "write") {
  const { status, data } = await app.request<ApiTokenCreatedReply>("/tokens", {
    method: "POST",
    user,
    body: { name: `${scope} script`, scope },
  });
  assert.equal(status, 201);
  return { token: data.token, id: data.info.id };
}

describe("the public API", () => {
  it("works only with API tokens, that can do what their scope says, until they're deleted", async () => {
    const owner = await app.signUp("Owner");
    const reader = await makeToken(owner, "read");
    const writer = await makeToken(owner, "write");

    assert.equal((await app.request("/v1/boards", { user: owner })).status, 401, "a login isn't an API token");
    assert.equal((await app.request("/tokens", { user: { token: writer.token } })).status, 401, "nor the other way");
    assert.equal((await app.request("/v1/boards", { user: { token: reader.token } })).status, 200);
    const refused = await app.request("/v1/boards", { method: "POST", user: { token: reader.token }, body: {} });
    assert.equal(refused.status, 403);

    const listed = await app.request<ApiTokenListReply>("/tokens", { user: owner });
    assert.equal(listed.data.tokens.length, 2);
    assert.equal(JSON.stringify(listed.data).includes(writer.token), false, "the token itself is never shown again");

    assert.equal((await app.request(`/tokens/${reader.id}`, { method: "DELETE", user: owner })).status, 204);
    assert.equal((await app.request("/v1/boards", { user: { token: reader.token } })).status, 401);
  });

  it("changes a board live for everyone on it, and saves it when nobody is", async () => {
    const owner = await app.signUp("Owner");
    const { token } = await makeToken(owner, "write");
    const api = { token };
    const created = await app.request<{ board: { id: string } }>("/v1/boards", {
      method: "POST",
      user: api,
      body: { title: "From a script" },
    });
    const boardId = created.data.board.id;

    const watcher = await app.connect(owner);
    await watcher.join(boardId);
    const written = await app.request<{ elements: ApiElement[] }>(`/v1/boards/${boardId}/elements`, {
      method: "POST",
      user: api,
      body: {
        elements: [
          { id: "idea", type: "sticky", x: 0, y: 0, width: 200, height: 200, text: "Ship it" },
          { id: "box", type: "rectangle", x: 400, y: 0, width: 100, height: 100 },
          { type: "arrow", from: "idea", to: "box" },
        ],
      },
    });
    assert.equal(written.status, 200);
    assert.equal(written.data.elements.length, 3);
    await eventually(() => watcher.of("board:op").length > 0, { message: "the change reaches the browser" });

    await app.request(`/v1/boards/${boardId}/elements`, {
      method: "POST",
      user: api,
      body: { elements: [{ id: "idea", text: "Ship it today" }] },
    });
    const read = await app.request<{ board: { elements: ApiElement[] } }>(`/v1/boards/${boardId}`, { user: api });
    const idea = read.data.board.elements.find((element) => element.id === "idea")!;
    assert.deepEqual([idea.text, idea.width], ["Ship it today", 200]);

    const removed = await app.request<{ removed: string[] }>(`/v1/boards/${boardId}/elements`, {
      method: "DELETE",
      user: api,
      body: { ids: ["box", "not-there"] },
    });
    assert.deepEqual(removed.data.removed, ["box"]);

    watcher.close();
    await app.request(`/v1/boards/${boardId}/elements`, {
      method: "POST",
      user: api,
      body: { elements: [{ id: "late", type: "text", x: 0, y: 300, text: "Added with nobody there" }] },
    });
    await eventually(
      async () => (await Board.findById(boardId).lean())?.elements.some((element) => element.id === "late"),
      { message: "the board is saved" },
    );
  });

  it("keeps to the person's own access", async () => {
    const owner = await app.signUp("Owner");
    const stranger = await app.signUp("Stranger");
    const boardId = await app.createBoard(owner);
    const { token } = await makeToken(stranger, "write");
    assert.equal((await app.request(`/v1/boards/${boardId}`, { user: { token } })).status, 403);

    await app.request(`/boards/${boardId}/link-access`, { method: "PATCH", user: owner, body: { linkAccess: "view" } });
    assert.equal((await app.request(`/v1/boards/${boardId}`, { user: { token } })).status, 200);
    const write = await app.request(`/v1/boards/${boardId}/elements`, {
      method: "POST",
      user: { token },
      body: { elements: [{ type: "text", x: 0, y: 0, text: "hi" }] },
    });
    assert.equal(write.status, 403);
  });
});

describe("the MCP server", () => {
  const rpc = (token: string | null, message: unknown, method = "POST") =>
    fetch(`${app.url}/mcp`, {
      method,
      headers: {
        "Content-Type": "application/json",
        Accept: "application/json, text/event-stream",
        ...(token && { Authorization: `Bearer ${token}` }),
      },
      body: method === "POST" ? JSON.stringify(message) : undefined,
    });

  it("speaks the protocol: version, tools, notifications, and nothing but POST", async () => {
    const owner = await app.signUp("Owner");
    const { token } = await makeToken(owner, "read");
    assert.equal((await rpc(null, { jsonrpc: "2.0", id: 1, method: "ping" })).status, 401);

    const init = await rpc(token, {
      jsonrpc: "2.0",
      id: 1,
      method: "initialize",
      params: { protocolVersion: "2025-03-26", capabilities: {}, clientInfo: { name: "test", version: "1" } },
    });
    const { result } = await init.json();
    assert.equal(result.protocolVersion, "2025-03-26", "the client's version, which the server speaks");
    assert.deepEqual(result.capabilities, { tools: {} });

    assert.equal((await rpc(token, { jsonrpc: "2.0", method: "notifications/initialized" })).status, 202);
    const tools = (await (await rpc(token, { jsonrpc: "2.0", id: 2, method: "tools/list" })).json()).result.tools;
    assert.ok(tools.some((tool: { name: string }) => tool.name === "add_or_update_elements"));
    const unknown = await (await rpc(token, { jsonrpc: "2.0", id: 3, method: "resources/list" })).json();
    assert.equal(unknown.error.code, -32601);
    assert.equal((await rpc(token, null, "GET")).status, 405);
  });

  it("runs tools as the token's owner, within the token's scope", async () => {
    const owner = await app.signUp("Owner");
    const boardId = await app.createBoard(owner);
    const reader = await makeToken(owner, "read");
    const writer = await makeToken(owner, "write");
    const call = async (token: string, name: string, args: unknown) =>
      (
        await (
          await rpc(token, { jsonrpc: "2.0", id: 1, method: "tools/call", params: { name, arguments: args } })
        ).json()
      ).result;

    const elements = [{ id: "n", type: "sticky", x: 0, y: 0, width: 100, height: 100, text: "From an assistant" }];
    const refused = await call(reader.token, "add_or_update_elements", { board_id: boardId, elements });
    assert.equal(refused.isError, true);
    assert.match(refused.content[0].text, /can only read/);

    const added = await call(writer.token, "add_or_update_elements", { board_id: boardId, elements });
    assert.equal(added.isError, undefined);
    const read = JSON.parse((await call(reader.token, "read_board", { board_id: boardId })).content[0].text);
    assert.equal(read.elements[0].text, "From an assistant");
  });
});
