import { eventually, rect, remove, startServer, upsert } from "./helpers.ts"; // first: it sets up the environment
import type { ServerInstance } from "./helpers.ts";
import assert from "node:assert/strict";
import { after, before, describe, it } from "node:test";
import { Notification } from "../src/models/notification.model.ts";
import { Version } from "../src/models/version.model.ts";
import { LINK_VISITORS_WARNING, MASS_REMOVAL } from "../src/realtime/link-watch.ts";

let app: ServerInstance;
before(async () => {
  app = await startServer();
});
after(() => app.stop());

/** A board whose owner drew `count` boxes on it, with its link set to let anyone edit. */
async function openBoard(count: number) {
  const owner = await app.signUp("Owner");
  const id = await app.createBoard(owner);
  await app.request(`/boards/${id}/link-access`, { method: "PATCH", user: owner, body: { linkAccess: "edit" } });
  const host = await app.connect(owner);
  await host.join(id);
  const boxes = Array.from({ length: count }, (_, i) => rect(`box${i}`, i * 10, 0));
  await host.op(id, upsert(...boxes));
  return { owner, id, host, ids: boxes.map((box) => box.id) };
}

describe("people from an edit link", () => {
  it("removing much of the board keeps a copy from before in version history, and tells the owner once", async () => {
    const { owner, id, host, ids } = await openBoard(MASS_REMOVAL + 10);
    const guest = await app.connect(null);
    await guest.join(id);
    await guest.op(id, remove(...ids.slice(0, MASS_REMOVAL - 5)));
    await guest.op(id, remove(...ids.slice(MASS_REMOVAL - 5, MASS_REMOVAL)));

    await eventually(() => Notification.exists({ board: id, type: "removals" }), { message: "the owner's warning" });
    const kept = await Version.findOne({ board: id, label: /edit-link/ }).lean();
    assert.equal(kept?.elements.length, MASS_REMOVAL + 10, "the whole board, from before the first removal");
    await eventually(() => host.of("notification").length === 1, { message: "the warning, live" });
    const { data } = await app.request("/notifications", { user: owner });
    assert.equal((data as { notifications: { type: string }[] }).notifications[0]?.type, "removals", "and listed");

    await guest.op(id, remove(...ids.slice(MASS_REMOVAL)));
    assert.equal(await Notification.countDocuments({ board: id, type: "removals" }), 1, "only once");
  });

  it("removals by the owner and invited editors aren't watched", async () => {
    const { id, host, ids } = await openBoard(MASS_REMOVAL + 1);
    await host.op(id, remove(...ids));
    await new Promise((resolve) => setTimeout(resolve, 200));
    assert.equal(await Notification.exists({ board: id, type: "removals" }), null);
  });

  it("tells the owner once when many people join from the edit link", async () => {
    const { id } = await openBoard(1);
    for (let i = 0; i < LINK_VISITORS_WARNING + 2; i += 1) await (await app.connect(null)).join(id);
    await eventually(() => Notification.exists({ board: id, type: "visitors" }), { message: "the warning" });
    await new Promise((resolve) => setTimeout(resolve, 200));
    assert.equal(await Notification.countDocuments({ board: id, type: "visitors" }), 1);
  });
});
