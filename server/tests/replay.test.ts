import assert from "node:assert/strict";
import { after, before, describe, it } from "node:test";
import type { ReplayReply } from "@inkboard/shared/socket";
import type { Element, ShapeElement } from "@inkboard/shared/types";
import mongoose from "mongoose";
import { ReplayStep } from "../src/models/replay-step.model.ts";
import { diffElements, mergeSteps, recordStep, REPLAY_LIMITS, replaySteps } from "../src/services/replay.ts";
import type { Step } from "../src/services/replay.ts";
import { eventually, rect, remove, startServer, upsert } from "./helpers.ts";
import type { ServerInstance, TestClient } from "./helpers.ts";

let app: ServerInstance;
const saved = { ...REPLAY_LIMITS };
before(async () => {
  REPLAY_LIMITS.stepMs = 30;
  app = await startServer();
});
after(async () => {
  Object.assign(REPLAY_LIMITS, saved);
  await app.stop();
});

const ids = (elements: Element[]) => elements.map((element) => element.id).sort();
const replayOf = (client: TestClient, boardId: string) =>
  new Promise<ReplayReply>((resolve) => client.socket.emit("board:replay", { boardId }, resolve));

// The board a replay ends on, played from the start.
function play(steps: Step[]) {
  const board = new Map<string, Element>();
  for (const step of steps) {
    for (const id of step.remove) board.delete(id);
    for (const element of step.upsert) board.set(element.id, element);
  }
  return [...board.values()];
}

describe("replay steps", () => {
  it("hold the elements that are new objects, and the ids that are gone", () => {
    const [a, b, c] = [rect("a"), rect("b"), rect("c")];
    const recorded = new Map<string, Element>([
      ["a", a],
      ["b", b],
    ]);
    const moved = { ...b, x1: 50 };
    const { step, next } = diffElements(recorded, [moved, c]);
    assert.deepEqual(step, { upsert: [moved, c], remove: ["a"] });
    assert.equal(diffElements(next, [moved, c]).step, null, "nothing changed since");
  });

  it("merge into one that does what both do", () => {
    const merged = mergeSteps(
      { upsert: [rect("a"), rect("b")], remove: ["old"] },
      { upsert: [{ ...rect("a"), x1: 9 }, rect("old")], remove: ["b"] },
    );
    assert.deepEqual(ids(merged.upsert), ["a", "old"]);
    assert.equal((merged.upsert.find((element) => element.id === "a") as ShapeElement).x1, 9);
    assert.deepEqual(merged.remove, ["b"]);
  });

  it("fold the oldest into the first once over budget, and still play to the same board", async () => {
    const boardId = await app.createBoard(await app.signUp("Folder"));
    const steps: Step[] = [
      { upsert: [rect("a"), rect("b")], remove: [] },
      { upsert: [{ ...rect("a"), x1: 5 }], remove: ["b"] },
      { upsert: [rect("c")], remove: [] },
      { upsert: [{ ...rect("c"), x1: 7 }], remove: [] },
    ];
    // Room for all but a byte of them, so the last one recorded folds some.
    const budget = steps.reduce((sum, step) => sum + mongoose.mongo.BSON.calculateObjectSize(step), -1);
    REPLAY_LIMITS.bytes = budget;
    try {
      for (const [i, step] of steps.entries()) await recordStep(boardId, step, new Date(1000 * (i + 1)));
    } finally {
      REPLAY_LIMITS.bytes = saved.bytes;
    }
    const kept = await replaySteps(boardId);
    assert.ok(kept.length < steps.length, "some were folded");
    assert.deepEqual(kept[0].remove, [], "the first step removes nothing");
    assert.equal(kept.at(-1)!.at, 4000, "the newest is kept as it was");
    assert.deepEqual(play(kept), play(steps));
    const total = (await ReplayStep.find({ board: boardId }).lean()).reduce((sum, step) => sum + step.bytes, 0);
    assert.ok(total <= budget);
  });
});

describe("watching a replay", () => {
  it("records what people draw, for members, and for link visitors only once the owner lets them", async () => {
    const owner = await app.signUp("Owner");
    const boardId = await app.createBoard(owner);
    const drawer = await app.connect(owner);
    await drawer.join(boardId);
    await drawer.op(boardId, upsert(rect("first")));
    await eventually(async () => (await replaySteps(boardId)).length === 1, { message: "the first step" });
    await drawer.op(boardId, upsert(rect("second")));
    await drawer.op(boardId, remove("first"));
    await eventually(async () => (await replaySteps(boardId)).length === 2, { message: "the second step" });

    const reply = await replayOf(drawer, boardId);
    assert.ok(reply.ok);
    assert.deepEqual(
      reply.steps.map((step) => [ids(step.upsert), step.remove]),
      [
        [["first"], []],
        [["second"], ["first"]],
      ],
    );
    assert.deepEqual(ids(reply.elements), ["second"]);

    await app.request(`/boards/${boardId}/link-access`, {
      method: "PATCH",
      user: owner,
      body: { linkAccess: "view" },
    });
    const visitor = await app.connect(null);
    await visitor.join(boardId);
    const refused = await replayOf(visitor, boardId);
    assert.equal(refused.ok, false);

    const { data } = await app.request<{ board: { linkReplay: boolean } }>(`/boards/${boardId}/link-access`, {
      method: "PATCH",
      user: owner,
      body: { linkReplay: true },
    });
    assert.equal(data.board.linkReplay, true);
    assert.equal((await replayOf(visitor, boardId)).ok, true);
  });
});
