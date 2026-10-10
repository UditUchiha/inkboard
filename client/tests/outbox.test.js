import assert from "node:assert/strict";
import { describe, it } from "node:test";
import { createCursorStore } from "../src/features/board/cursors.ts";
import { createOutbox } from "../src/features/board/outbox.ts";

const rect = (id, version = 1) => ({ id, type: "rectangle", x1: 0, y1: 0, x2: 10, y2: 10, version, versionNonce: 1 });
const ids = (op) => [...op.upsert.map((element) => element.id), ...op.remove.map((removal) => removal.id)];
const ok = { ok: true };

describe("outbox", () => {
  it("sends what was queued as one piece, and is busy until it is confirmed", () => {
    const states = [];
    const outbox = createOutbox({ onChange: (busy) => states.push(busy) });
    outbox.add({ upsert: [rect("a"), rect("b")], remove: [{ id: "c", version: 2, versionNonce: 1 }] });
    assert.equal(outbox.busy(), true);
    const piece = outbox.take();
    assert.deepEqual(ids(piece.op), ["a", "b", "c"]);
    assert.equal(outbox.take(), null);
    assert.equal(outbox.busy(), true); // sent, not confirmed
    assert.equal(outbox.settle(piece.seq, null, ok).kind, "ok");
    assert.equal(outbox.busy(), false);
    assert.equal(states.at(-1), false);
  });

  it("queues a change again after a timeout or a rate limit, unless a newer change replaced it", () => {
    const outbox = createOutbox();
    outbox.add({ upsert: [rect("a"), rect("b")] });
    const first = outbox.take();
    outbox.add({ upsert: [rect("b", 2)] });
    const second = outbox.take(); // b again, newer
    const retry = outbox.settle(first.seq, new Error("timeout"), undefined);
    assert.equal(retry.kind, "retry");
    assert.deepEqual(ids(retry.again), ["a"]); // b was superseded by the second piece
    assert.equal(retry.delay, 400);
    const limited = outbox.settle(second.seq, null, { ok: false, reason: "rate" });
    assert.equal(limited.kind, "retry");
    assert.ok(limited.delay > retry.delay);
    assert.deepEqual(ids(outbox.unsent()).sort(), ["a", "b"]);
  });

  it("waits longer each time the server turns a change away as rate limited, then starts over", () => {
    const outbox = createOutbox({ random: () => 1 }); // no jitter: the longest wait
    outbox.add({ upsert: [rect("a")] });
    const delays = [];
    let last;
    for (let round = 0; round < 8; round += 1) {
      last = outbox.settle(outbox.take().seq, null, { ok: false, reason: "rate" });
      assert.equal(last.kind, "retry");
      delays.push(last.delay);
    }
    assert.deepEqual(delays.slice(0, 5), [1000, 2000, 4000, 8000, 16000]);
    assert.deepEqual(delays.slice(5), [30_000, 30_000, 30_000], "never past half a minute");
    assert.equal(last.slow, true, "it says so once it keeps happening");
    assert.equal(outbox.settle(outbox.take().seq, null, ok).kind, "ok");

    outbox.add({ upsert: [rect("a", 2)] });
    const again = outbox.settle(outbox.take().seq, null, { ok: false, reason: "rate" });
    assert.equal(again.delay, 1000, "a change going through starts the wait over");
    assert.equal(again.slow, undefined);

    const jittered = createOutbox({ random: () => 0 });
    jittered.add({ upsert: [rect("b")] });
    assert.equal(jittered.settle(jittered.take().seq, null, { ok: false, reason: "rate" }).delay, 500);
  });

  it("asks to join again, keeping the change, when the server has no session", () => {
    const outbox = createOutbox();
    outbox.add({ upsert: [rect("a")] });
    const piece = outbox.take();
    const result = outbox.settle(piece.seq, null, { ok: false, reason: "noSession" });
    assert.equal(result.kind, "rejoin");
    assert.deepEqual(ids(outbox.unsent()), ["a"]);
  });

  it("never retries a change the server refused for good", () => {
    for (const reason of ["invalid", "tooLarge", "forbidden", undefined]) {
      const outbox = createOutbox();
      outbox.add({ upsert: [rect("a")] });
      const piece = outbox.take();
      const result = outbox.settle(piece.seq, null, { ok: false, reason });
      assert.equal(result.kind, "resync");
      assert.equal(outbox.hasPending(), false);
    }
  });

  it("passes on the elements the server cleaned and the ids it dropped", () => {
    const outbox = createOutbox();
    outbox.add({ upsert: [rect("a")] });
    const piece = outbox.take();
    const result = outbox.settle(piece.seq, null, { ok: true, cleaned: [rect("a")], dropped: ["z"] });
    assert.deepEqual(result.dropped, ["z"]);
    assert.equal(result.cleaned.length, 1);
  });

  it("sends a big change as one group of pieces, one after the other, and drops the group at the first refusal", () => {
    const outbox = createOutbox();
    const big = (id) => ({ ...rect(id), text: "x".repeat(400_000) });
    outbox.add({ upsert: [big("a"), big("b"), big("c")] });
    const first = outbox.take();
    assert.deepEqual(ids(first.op), ["a", "b"]);
    assert.equal(first.group.total, 2);
    assert.equal(first.group.index, 0);
    assert.equal(outbox.take(), null); // the rest waits for the first piece's reply
    const afterFirst = outbox.settle(first.seq, null, ok);
    assert.deepEqual(ids(afterFirst.next.op), ["c"]);
    assert.deepEqual(afterFirst.next.group, { id: first.group.id, index: 1, total: 2 });
    const refused = outbox.settle(afterFirst.next.seq, null, { ok: false, reason: "tooLarge" });
    assert.equal(refused.kind, "resync"); // the server drops the group, so nothing of it was saved
  });

  it("sends a small change without a group", () => {
    const outbox = createOutbox();
    outbox.add({ upsert: [rect("a")] });
    assert.equal(outbox.take().group, undefined);
  });

  it("queues a whole group again, pieces already answered included, when a later piece fails to arrive", () => {
    const outbox = createOutbox();
    const big = (id) => ({ ...rect(id), text: "x".repeat(400_000) });
    outbox.add({ upsert: [big("a"), big("b"), big("c")] });
    const first = outbox.take();
    const second = outbox.settle(first.seq, null, ok).next;
    const retry = outbox.settle(second.seq, new Error("timeout"), undefined);
    assert.equal(retry.kind, "retry");
    assert.deepEqual(ids(outbox.unsent()).sort(), ["a", "b", "c"]);
    const again = outbox.take();
    assert.notEqual(again.group.id, first.group.id, "a new group, the server dropped the old one");
  });

  it("does the same when the connection drops between pieces", () => {
    const outbox = createOutbox();
    const big = (id) => ({ ...rect(id), text: "x".repeat(400_000) });
    outbox.add({ upsert: [big("a"), big("b"), big("c")] });
    const first = outbox.take();
    outbox.settle(first.seq, null, ok);
    outbox.requeueSent();
    assert.deepEqual(ids(outbox.unsent()).sort(), ["a", "b", "c"]);
  });

  it("sends a growing stroke less often, so its traffic does not grow with every point", () => {
    const outbox = createOutbox();
    const stroke = (count) => ({ id: "s", type: "pen", points: Array.from({ length: count }, () => [0, 0, 0.5]) });
    outbox.add({ upsert: [rect("a")] });
    assert.equal(outbox.flushDelay(), 40);
    outbox.take();
    outbox.add({ upsert: [stroke(100)] });
    const short = outbox.flushDelay();
    outbox.add({ upsert: [stroke(1000)] });
    const long = outbox.flushDelay();
    assert.ok(short > 40 && long > short, `${short} then ${long}`);
    outbox.add({ upsert: [stroke(100_000)] });
    assert.ok(outbox.flushDelay() <= 440, "but never far behind");
    outbox.take();
    assert.equal(outbox.flushDelay(), 40, "a new stroke starts quick again");
  });

  it("puts sent but unconfirmed changes back when the connection drops", () => {
    const outbox = createOutbox();
    outbox.add({ upsert: [rect("a")] });
    const piece = outbox.take();
    outbox.add({ upsert: [rect("b")] });
    assert.deepEqual(ids(outbox.unsent()), ["b"]);
    outbox.requeueSent();
    assert.deepEqual(ids(outbox.unsent()).sort(), ["a", "b"]);
    assert.equal(outbox.settle(piece.seq, new Error("timeout"), undefined).kind, "ignore"); // a late reply is ignored
  });

  it("forgets unsent changes when another board is opened, so they are never sent to it", () => {
    const outbox = createOutbox();
    assert.equal(outbox.switchTo("A"), false);
    outbox.add({ upsert: [rect("secret")] });
    const piece = outbox.take();
    outbox.add({ upsert: [rect("later")] });
    assert.equal(outbox.switchTo("A"), false); // same board: nothing happens
    assert.equal(outbox.hasPending(), true);
    assert.equal(outbox.switchTo("B"), true);
    assert.equal(outbox.hasPending(), false);
    assert.equal(outbox.busy(), false);
    assert.equal(outbox.take(), null);
    assert.equal(outbox.settle(piece.seq, null, { ok: false, reason: "noSession" }).kind, "ignore");
  });
});

describe("outbox and changes sent in pieces", () => {
  const big = (id, version = 1) => ({ ...rect(id, version), text: "x".repeat(400_000) });
  const removal = (id) => ({ id, version: 9, versionNonce: 1 });

  it("sends nothing else while a change in pieces is going out, then what was made meanwhile", () => {
    const outbox = createOutbox();
    outbox.add({ upsert: [big("a"), big("b"), big("c")] });
    const first = outbox.take();
    // A second big change (the drag goes on), and a removal, made while the first is uploading.
    outbox.add({ upsert: [big("a", 2), big("b", 2), big("c", 2)] });
    outbox.add({ remove: [removal("d")] });
    assert.equal(outbox.take(), null, "a second group would make the server drop the first");
    const second = outbox.settle(first.seq, null, ok).next;
    assert.equal(outbox.take(), null, "the removal would be taken in before the upload, then undone by it");
    const done = outbox.settle(second.seq, null, ok);
    assert.equal(done.kind, "ok");
    assert.equal(done.next, undefined);
    const after = outbox.take();
    assert.notEqual(after.group.id, first.group.id);
    assert.deepEqual(ids(after.op), ["a", "b"]);
    assert.deepEqual(ids(outbox.settle(after.seq, null, ok).next.op), ["c", "d"]);
  });

  it("lets other changes go once a change in pieces fails", () => {
    const outbox = createOutbox();
    outbox.add({ upsert: [big("a"), big("b"), big("c")] });
    const first = outbox.take();
    outbox.add({ remove: [removal("d")] });
    assert.equal(outbox.settle(first.seq, new Error("timeout"), undefined).kind, "retry");
    assert.deepEqual(ids(outbox.unsent()).sort(), ["a", "b", "c", "d"], "all of it again, with what came meanwhile");
    assert.ok(outbox.take(), "and it can go now");
  });

  it("sends a change again, whole, when the server stopped waiting for its pieces", () => {
    const outbox = createOutbox();
    outbox.add({ upsert: [big("a"), big("b"), big("c")] });
    const first = outbox.take();
    const second = outbox.settle(first.seq, null, ok).next;
    const late = outbox.settle(second.seq, null, { ok: false, reason: "expired" });
    assert.equal(late.kind, "retry");
    assert.deepEqual(ids(outbox.unsent()).sort(), ["a", "b", "c"]);
  });

  it("gives everything left to send at once when leaving, the rest of a change in pieces first", () => {
    const outbox = createOutbox();
    outbox.add({ upsert: [big("a"), big("b"), big("c"), big("d"), big("e")] });
    const first = outbox.take(); // pieces of 2, 2 and 1
    outbox.add({ remove: [removal("z")] });
    const rest = outbox.drain();
    assert.deepEqual(
      rest.map((piece) => piece.group && [piece.group.id === first.group.id, piece.group.index]),
      [[true, 1], [true, 2], undefined],
    );
    assert.deepEqual(ids(rest[2].op), ["z"]);
    assert.equal(outbox.hasPending(), false);
    // The replies still settle them.
    assert.equal(outbox.settle(first.seq, null, ok).next, undefined, "already sent");
    for (const piece of rest) assert.equal(outbox.settle(piece.seq, null, ok).kind, "ok");
    assert.equal(outbox.busy(), false);
  });

  it("queues again, rather than giving up, a piece refused because one before it failed", () => {
    const outbox = createOutbox();
    outbox.add({ upsert: [big("a"), big("b"), big("c"), big("d"), big("e")] });
    const first = outbox.take();
    const [second, third] = outbox.drain();
    assert.equal(outbox.settle(first.seq, null, ok).kind, "ok");
    assert.equal(outbox.settle(second.seq, new Error("timeout"), undefined).kind, "retry");
    const after = outbox.settle(third.seq, null, { ok: false, reason: "invalid" });
    assert.equal(after.kind, "retry");
    assert.deepEqual(ids(outbox.unsent()).sort(), ["a", "b", "c", "d", "e"]);
  });

  it("says which stamps cleaned elements were sent with", () => {
    const outbox = createOutbox();
    outbox.add({ upsert: [rect("a", 4)] });
    const piece = outbox.take();
    const result = outbox.settle(piece.seq, null, { ok: true, cleaned: [rect("a", 2)] });
    assert.deepEqual(result.sent.get("a"), { version: 4, versionNonce: 1 });
  });
});

describe("cursor store", () => {
  it("tracks pointers and only tells subscribers when something changed", () => {
    const cursors = createCursorStore();
    let calls = 0;
    cursors.subscribe(() => (calls += 1));
    cursors.move("s1", { x: 1, y: 2 });
    cursors.move("s2", { x: 3, y: 4 });
    assert.deepEqual(Object.keys(cursors.getSnapshot()), ["s1", "s2"]);
    cursors.move("s1", null);
    cursors.keepOnly(["s2"]);
    cursors.move("gone", null);
    assert.equal(calls, 3);
    cursors.clear();
    assert.deepEqual(cursors.getSnapshot(), {});
  });
});
