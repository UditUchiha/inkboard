import assert from "node:assert/strict";
import { after, before, describe, it } from "node:test";
import type { Peer } from "@inkboard/shared/socket";
import { eventually, rect, roundTrip, startServer, upsert } from "./helpers.ts";
import type { ServerInstance, TestClient, TestJoinReply } from "./helpers.ts";

let app: ServerInstance;
before(async () => {
  app = await startServer();
});
after(() => app.stop());

const joinAsEmbed = (client: TestClient, boardId: string) =>
  new Promise<TestJoinReply>((resolve) => client.socket.emit("board:join", { boardId, embed: true }, resolve));

describe("an embedded board", () => {
  it("only views, even on an edit link, isn't shown to the others, and still sees their changes", async () => {
    const owner = await app.signUp("Owner");
    const boardId = await app.createBoard(owner);
    const setLink = (linkAccess: string) =>
      app.request(`/boards/${boardId}/link-access`, { method: "PATCH", user: owner, body: { linkAccess } });
    await setLink("edit");
    const drawer = await app.connect(owner);
    await drawer.join(boardId);

    const embed = await app.connect(null);
    const joined = await joinAsEmbed(embed, boardId);
    assert.equal(joined.ok, true);
    assert.equal(joined.board.role, "viewer");
    assert.equal((await embed.op(boardId, upsert(rect("nope")))).readOnly, true);

    await drawer.op(boardId, upsert(rect("live")));
    await eventually(() => embed.of("board:op").length > 0, { message: "the change reaches the embed" });

    await roundTrip(drawer);
    const listed = (drawer.last("presence") as Peer[]).map((peer) => peer.socketId);
    assert.deepEqual(listed, [drawer.socket.id]);

    await setLink("suggest"); // access is checked again: still only viewing
    await roundTrip(embed);
    assert.equal(embed.of("board:role").length, 0);
  });
});
// That an embed's page can be framed by other sites is checked with the built app (auth-security.test.ts).
