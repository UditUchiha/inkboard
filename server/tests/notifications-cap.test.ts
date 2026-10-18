import { startServer } from "./helpers.ts"; // first: it sets up the environment
import assert from "node:assert/strict";
import { after, before, describe, it } from "node:test";
import { Notification } from "../src/models/notification.model.ts";
import { MAX_NOTIFICATIONS_PER_PERSON } from "../src/services/notifications.ts";
import type { ServerInstance } from "./helpers.ts";

let app: ServerInstance;
before(async () => {
  app = await startServer();
});
after(() => app.stop());

describe("how many notifications one person keeps", () => {
  it("is capped: a new one pushes out the oldest, read or not", async () => {
    const owner = await app.signUp("Owner");
    const reader = await app.signUp("Reader", { verified: true });
    const bystander = await app.signUp("Bystander");
    const board = await app.createBoard(owner);
    // A full set for the reader, one a minute going back, and one for someone else that must stay.
    const now = Date.now();
    const full = await Notification.insertMany(
      Array.from({ length: MAX_NOTIFICATIONS_PER_PERSON }, (_, index) => ({
        user: reader.id,
        type: "mention",
        actor: owner.id,
        board,
        read: index % 2 === 0,
        createdAt: new Date(now - (index + 1) * 60_000),
      })),
    );
    await Notification.create({ user: bystander.id, type: "mention", actor: owner.id, board });
    const oldest = full.at(-1)!;

    const invited = await app.request(`/boards/${board}/collaborators`, {
      method: "POST",
      user: owner,
      body: { email: reader.email },
    });
    assert.equal(invited.status, 201);

    assert.equal(await Notification.countDocuments({ user: reader.id }), MAX_NOTIFICATIONS_PER_PERSON);
    assert.equal(await Notification.exists({ _id: oldest._id }), null, "the oldest went");
    assert.ok(await Notification.exists({ user: reader.id, type: "invite" }), "the new one stayed");
    assert.equal(await Notification.countDocuments({ user: bystander.id }), 1, "nobody else's were touched");
  });
});
