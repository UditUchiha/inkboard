import assert from "node:assert/strict";
import { after, before, describe, it } from "node:test";
import mongoose from "mongoose";
import { Notification } from "../src/models/notification.model.js";
import { startServer } from "./helpers.js";

let app;
before(async () => {
  app = await startServer();
});
after(() => app.stop());

const page = async (user, before) =>
  (await app.request(`/notifications${before ? `?before=${before}` : ""}`, { user })).data;

describe("paging through notifications", () => {
  it("moves on past a page whose every notification is skipped", async () => {
    const owner = await app.signUp("Owner");
    const reader = await app.signUp("Reader");
    const board = await app.createBoard(owner);
    await app.request(`/boards/${board}/link-access`, { method: "PATCH", user: owner, body: { linkAccess: "view" } });
    const notification = (actor) => ({ user: reader.id, type: "invite", actor, board });
    // Two from someone still here, then 35 newer ones from an account that is gone (which aren't shown).
    await Notification.create([notification(owner.id), notification(owner.id)]);
    const gone = new mongoose.Types.ObjectId();
    await Notification.create(Array.from({ length: 35 }, () => notification(gone)));

    const first = await page(reader);
    assert.deepEqual(first.notifications, []);
    assert.equal(first.more, true);
    assert.ok(first.next, "a place to carry on from, though nothing was shown");

    const second = await page(reader, first.next);
    assert.equal(second.notifications.length, 2);
    assert.equal(second.more, false);
    assert.equal(second.next, null);
  });
});
