import { rect, startServer, upsert } from "./helpers.js"; // first: it sets up the environment
import assert from "node:assert/strict";
import { after, before, describe, it } from "node:test";
import { Board } from "../src/models/board.model.js";
import { closeRealtime } from "../src/realtime/index.js";
import { SYNC_FORMAT } from "../src/realtime/operations.js";

let app;
before(async () => {
  app = await startServer();
});
after(() => app.stop());

describe("shutting down", () => {
  it("keeps what was acknowledged but not saved yet", async () => {
    const owner = await app.signUp("Owner");
    const id = await app.createBoard(owner);
    const client = await app.connect(owner);
    await client.join(id, { sync: SYNC_FORMAT });
    assert.equal((await client.op(id, upsert(rect("kept")))).ok, true);

    // The sequence from index.js: people are disconnected, and each board saves as the last of them leaves.
    await closeRealtime();
    const saved = await Board.findById(id).lean();
    assert.deepEqual(
      saved.elements.map((element) => element.id),
      ["kept"],
    );
  });
});
