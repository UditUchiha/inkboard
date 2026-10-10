import { eventually, rect, remove, startServer, upsert } from "./helpers.js"; // first: it sets up the environment
import assert from "node:assert/strict";
import { after, before, describe, it } from "node:test";
import { MAX_VERSION } from "@inkboard/shared/board-merge";
import { MAX_TEXT_LENGTH } from "@inkboard/shared/element-rules";
import { Board } from "../src/models/board.model.ts";
import { flushAllSessions } from "../src/realtime/index.js";
import { MAX_BOARD_BYTES, MAX_ELEMENTS_PER_BOARD, sanitizeElements, SYNC_FORMAT } from "../src/realtime/operations.js";
import { LIMITS } from "../src/realtime/rate-limit.js";

let app;
before(async () => {
  app = await startServer();
});
after(() => app.stop());

const stored = async (boardId) => (await Board.findById(boardId).lean()).elements.map((element) => element.id);
const ids = (elements) => elements.map((element) => element.id);
const stamped = (element, version = 1) => ({ ...element, index: "a0", version, versionNonce: 0 });

async function ownerOnBoard() {
  const owner = await app.signUp("Owner");
  const id = await app.createBoard(owner);
  const client = await app.connect(owner);
  await client.join(id, { sync: SYNC_FORMAT });
  return { owner, id, client };
}

describe("joining a board again", () => {
  it("shows the same board, with changes that haven't been saved yet (and keeps them)", async () => {
    const { id, client } = await ownerOnBoard();
    await client.op(id, upsert(rect("fresh")));
    const joined = await client.join(id, { sync: SYNC_FORMAT });
    assert.deepEqual(ids(joined.board.elements), ["fresh"]);
    await flushAllSessions();
    assert.deepEqual(await stored(id), ["fresh"]);
  });

  it("shows what was done on a board after going to another and coming back, as the only person on it", async () => {
    const { owner, id, client } = await ownerOnBoard();
    const other = await app.createBoard(owner, "Other");
    await client.op(id, upsert(rect("fresh")));
    await client.join(other, { sync: SYNC_FORMAT });
    const back = await client.join(id, { sync: SYNC_FORMAT });
    assert.deepEqual(ids(back.board.elements), ["fresh"]);
    await flushAllSessions();
    assert.deepEqual(await stored(id), ["fresh"]);
  });
});

describe("joining as the last person leaves", () => {
  it("leaves the newcomer with a board that takes their changes", async () => {
    const owner = await app.signUp("Owner");
    const friend = await app.signUp("Friend");
    for (let round = 0; round < 15; round += 1) {
      const id = await app.createBoard(owner, `Round ${round}`);
      await app.request(`/boards/${id}/link-access`, { method: "PATCH", user: owner, body: { linkAccess: "edit" } });
      const leaver = await app.connect(owner);
      await leaver.join(id, { sync: SYNC_FORMAT });
      await leaver.op(id, upsert(stamped(rect(`before-${round}`))));
      const joiner = await app.connect(friend);

      leaver.close();
      const joined = await joiner.join(id, { sync: SYNC_FORMAT });
      assert.equal(joined.ok, true);
      const result = await joiner.op(id, upsert(stamped({ ...rect(`after-${round}`), index: "a1" })));
      assert.equal(result.ok, true, `round ${round}: ${JSON.stringify(result)}`);
      await flushAllSessions();
      assert.deepEqual((await stored(id)).sort(), [`after-${round}`, `before-${round}`].sort());
    }
  });
});

describe("saving", () => {
  const saves = (pretend) => {
    const original = Board.collection.updateOne;
    Board.collection.updateOne = pretend(original.bind(Board.collection));
    return () => {
      Board.collection.updateOne = original;
    };
  };

  it("runs one save at a time per board, so an older copy can't land after a newer one", async () => {
    const { id, client } = await ownerOnBoard();
    let running = 0;
    let most = 0;
    const restore = saves((original) => async (...args) => {
      running += 1;
      most = Math.max(most, running);
      await new Promise((resolve) => setTimeout(resolve, 80));
      try {
        return await original(...args);
      } finally {
        running -= 1;
      }
    });
    try {
      await client.op(id, upsert(stamped(rect("one"))));
      await eventually(() => running === 1, { message: "the first save to start" });
      await client.op(id, upsert(stamped({ ...rect("two"), index: "a1" })));
      await flushAllSessions();
    } finally {
      restore();
    }
    assert.equal(most, 1);
    assert.deepEqual((await stored(id)).sort(), ["one", "two"]);
  });

  it("keeps a board whose last save failed, for whoever opens it next, and saves it when it can", async () => {
    const { owner, id, client } = await ownerOnBoard();
    let attempts = 0;
    const restore = saves(() => async () => {
      attempts += 1;
      throw new Error("the database is away");
    });
    const log = console.error;
    console.error = () => {};
    try {
      await client.op(id, upsert(rect("unsaved")));
      client.close();
      await eventually(() => attempts > 0, { message: "the failing save" });
    } finally {
      restore();
      console.error = log;
    }
    const back = await app.connect(owner);
    const joined = await back.join(id, { sync: SYNC_FORMAT });
    assert.deepEqual(ids(joined.board.elements), ["unsaved"], "not read back from the database, which never got it");
    await flushAllSessions();
    assert.deepEqual(await stored(id), ["unsaved"]);
  });
});

describe("restoring a version", () => {
  it("can't be undone by someone opening the board at that moment", async () => {
    const { owner, id, client } = await ownerOnBoard();
    await client.op(id, upsert(stamped(rect("kept"))));
    await flushAllSessions();
    const version = await app.request(`/boards/${id}/versions`, {
      method: "POST",
      user: owner,
      body: { label: "Start" },
    });
    await client.op(id, upsert(stamped({ ...rect("added"), index: "a1" })));
    client.close();
    await eventually(async () => (await stored(id)).length === 2, {
      message: "the board saved as the last person left",
    });

    const viewer = await app.connect(owner);
    const [restored, joined] = await Promise.all([
      app.request(`/boards/${id}/versions/${version.data.version.id}/restore`, { method: "POST", user: owner }),
      viewer.join(id, { sync: SYNC_FORMAT }),
    ]);
    assert.equal(restored.status, 200);
    const seen = (await viewer.join(id, { sync: SYNC_FORMAT })).board.elements;
    assert.deepEqual(ids(seen), ["kept"], `opened as ${ids(joined.board.elements)}`);
    await flushAllSessions();
    assert.deepEqual(await stored(id), ["kept"]);
  });
});

describe("what an acknowledgement says", () => {
  it("lists elements that were refused, and gives back elements as stored where that isn't how they were sent", async () => {
    const { id, client } = await ownerOnBoard();
    const label = { ...stamped(rect("arrow")), type: "arrow", text: "x".repeat(MAX_TEXT_LENGTH + 5), font: "hand" };
    const note = {
      id: "note",
      type: "sticky",
      x1: 0,
      y1: 0,
      x2: 100,
      y2: 100,
      text: "y".repeat(MAX_TEXT_LENGTH + 1),
      fill: "#ffec99",
      font: "hand",
    };
    const result = await client.op(id, upsert(label, note, rect("fine")));
    assert.equal(result.ok, true);
    assert.deepEqual(ids(result.cleaned), ["arrow"]);
    assert.equal(result.cleaned[0].text.length, MAX_TEXT_LENGTH);
    assert.deepEqual(result.dropped, ["note"]);
  });

  it("gives back the stored element when a change to it is refused", async () => {
    const { id, client } = await ownerOnBoard();
    const note = {
      id: "note",
      type: "sticky",
      x1: 0,
      y1: 0,
      x2: 100,
      y2: 100,
      text: "short",
      fill: "#ffec99",
      font: "hand",
    };
    await client.op(id, upsert(stamped(note)));
    const tooLong = stamped({ ...note, text: "y".repeat(MAX_TEXT_LENGTH + 1) }, 2);
    const result = await client.op(id, upsert(tooLong, stamped(rect("with-it"))));
    assert.equal(result.ok, true);
    assert.equal(result.dropped, undefined);
    assert.equal(result.cleaned[0].text, "short");
  });

  it("names why an operation wasn't taken, and tells a plain success from one that was changed", async () => {
    const { id, client } = await ownerOnBoard();
    assert.deepEqual(await client.op(id, upsert(stamped(rect("plain")))), { ok: true });
    assert.equal((await client.op(id, upsert({ id: "bad", type: "pen" }))).reason, "invalid");

    const many = Array.from({ length: MAX_ELEMENTS_PER_BOARD + 1 }, (_, n) => `m${n}`);
    assert.equal((await client.op(id, remove(...many))).reason, "tooLarge");
  });
});

describe("a board that is full", () => {
  it("tells the sender which new elements it left out", async () => {
    const owner = await app.signUp("Full");
    const full = Array.from({ length: MAX_ELEMENTS_PER_BOARD }, (_, n) => rect(`e${n}`));
    const created = await app.request("/boards", {
      method: "POST",
      user: owner,
      body: { title: "Full", elements: full },
    });
    const id = created.data.board.id;
    const client = await app.connect(owner);
    await client.join(id, { sync: SYNC_FORMAT });

    const result = await client.op(id, upsert(stamped(rect("extra")), stamped({ ...rect("e0"), x1: 5 }, 2)));
    assert.deepEqual(result, { ok: true, dropped: ["extra"] });
  });
});

describe("removals of ids a board never had", () => {
  it("leave no trace, so they can't push out the removals that count", async () => {
    const { owner, id, client } = await ownerOnBoard();
    await client.op(id, upsert(stamped(rect("real"))));
    await client.op(id, { upsert: [], remove: [{ id: "real", version: 3, versionNonce: 0 }] });
    for (let batch = 0; batch < 3; batch += 1) {
      const fakes = Array.from({ length: 2000 }, (_, n) => ({ id: `fake-${batch}-${n}`, version: 5, versionNonce: 0 }));
      assert.equal((await client.op(id, { upsert: [], remove: fakes })).ok, true);
    }
    const joined = await (await app.connect(owner)).join(id, { sync: SYNC_FORMAT });
    assert.deepEqual(ids(joined.removed), ["real"]);
  });
});

describe("a forged version", () => {
  it("can't put an element out of reach of later changes", async () => {
    const { id, client } = await ownerOnBoard();
    assert.equal((await client.op(id, upsert(stamped(rect("forged"), MAX_VERSION)))).ok, true);
    assert.equal((await client.op(id, upsert(stamped({ ...rect("forged"), x1: 40 }, 2)))).ok, true);
    const seen = (await client.join(id, { sync: SYNC_FORMAT })).board;
    assert.equal(seen.elements[0].x1, 40, "the next edit still wins");
    assert.ok(seen.elements[0].version < 100);
  });
});

describe("the stacking key of new elements", () => {
  it("stays a key the board takes, even above the highest key it accepts", async () => {
    const { id, client } = await ownerOnBoard();
    const top = `m${"z".repeat(13)}`;
    assert.equal((await client.op(id, upsert({ ...rect("top"), index: top, version: 1, versionNonce: 0 }))).ok, true);
    await client.op(id, upsert({ ...rect("next"), version: 1, versionNonce: 0 }));
    const seen = (await client.join(id, { sync: SYNC_FORMAT })).board.elements;
    assert.deepEqual(
      seen.map((element) => element.index),
      [top, top],
    );
  });
});

describe("a flood of changes", () => {
  it("is turned away with a reason the sender can wait out", async () => {
    const { id, client } = await ownerOnBoard();
    const replies = await Promise.all(
      Array.from({ length: LIMITS.op.burst * 3 }, (_, n) => client.op(id, upsert(stamped(rect(`flood-${n}`))))),
    );
    assert.ok(
      replies.some((reply) => reply.ok),
      "some get through",
    );
    const refused = replies.filter((reply) => !reply.ok);
    assert.ok(refused.length > 0);
    assert.ok(refused.every((reply) => reply.reason === "rate"));
  });
});

describe("boards made in one request", () => {
  it("leave out strokes too big to store, and what wouldn't fit in a board", () => {
    const stroke = (id, count) => ({
      id,
      type: "pen",
      points: Array.from({ length: count }, (_, n) => [n + 0.25, n + 0.5, 0.5]),
    });
    assert.deepEqual(ids(sanitizeElements([stroke("huge", 40_000), rect("small")])), ["small"]);

    const strokes = Array.from({ length: 40 }, (_, n) => stroke(`s${n}`, 10_000));
    const kept = sanitizeElements(strokes);
    assert.ok(kept.length > 0 && kept.length < strokes.length, `${kept.length} of ${strokes.length}`);
    const bytes = kept.reduce((sum, element) => sum + Buffer.byteLength(JSON.stringify(element)), 0);
    assert.ok(bytes < MAX_BOARD_BYTES);
  });

  it("is refused over HTTP too when the one stroke is too big", async () => {
    const owner = await app.signUp("Importer");
    const points = Array.from({ length: 45_000 }, (_, n) => [n + 0.25, n + 0.5, 0.5]);
    const { status, data } = await app.request("/boards", {
      method: "POST",
      user: owner,
      body: { title: "Big", elements: [{ id: "huge", type: "pen", points }, rect("small")] },
    });
    assert.equal(status, 201);
    assert.deepEqual(ids(data.board.elements), ["small"]);
  });
});
