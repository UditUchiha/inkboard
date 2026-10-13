import assert from "node:assert/strict";
import { describe, it } from "node:test";
import { countdownAt, nextCountdown } from "../src/realtime/countdown.ts";

describe("the board's timer", () => {
  it("counts down from when it was started", () => {
    const started = nextCountdown(null, { action: "start", seconds: 90 }, 1000)!;
    assert.deepEqual(countdownAt(started, 31_000), { total: 90_000, left: 60_000, running: true });
    assert.deepEqual(countdownAt(started, 200_000), { total: 90_000, left: 0, running: false });
  });

  it("keeps the time left while paused, and goes on from there when resumed", () => {
    const started = nextCountdown(null, { action: "start", seconds: 60 }, 0)!;
    const paused = nextCountdown(started, { action: "pause" }, 20_000)!;
    assert.deepEqual(countdownAt(paused, 50_000), { total: 60_000, left: 40_000, running: false });
    const resumed = nextCountdown(paused, { action: "resume" }, 50_000)!;
    assert.deepEqual(countdownAt(resumed, 60_000), { total: 60_000, left: 30_000, running: true });
  });

  it("stops, and starts again from the top", () => {
    const started = nextCountdown(null, { action: "start", seconds: 60 }, 0)!;
    assert.equal(nextCountdown(started, { action: "stop" }, 1000), null);
    const restarted = nextCountdown(started, { action: "start", seconds: 30 }, 5000)!;
    assert.deepEqual(countdownAt(restarted, 5000), { total: 30_000, left: 30_000, running: true });
  });

  it("ignores what changes nothing", () => {
    const started = nextCountdown(null, { action: "start", seconds: 60 }, 0)!;
    assert.equal(nextCountdown(started, { action: "resume" }, 1000), undefined, "it is running");
    assert.equal(nextCountdown(started, { action: "pause" }, 70_000), undefined, "it has run out");
    assert.equal(nextCountdown(null, { action: "pause" }, 0), undefined, "there is none");
    assert.equal(nextCountdown(null, { action: "stop" }, 0), undefined, "there is none");
  });

  it("refuses what isn't a timer", () => {
    for (const payload of [
      null,
      "start",
      {},
      { action: "start" },
      { action: "start", seconds: "60" },
      { action: "start", seconds: 0 },
      { action: "start", seconds: Number.NaN },
      { action: "start", seconds: Number.POSITIVE_INFINITY },
      { action: "start", seconds: 24 * 60 * 60 + 1 },
      { action: "explode" },
    ]) {
      assert.equal(nextCountdown(null, payload, 0), undefined, JSON.stringify(payload));
    }
  });
});
