import assert from "node:assert/strict";
import { describe, it } from "node:test";
import type { ElementType } from "@inkboard/shared/types";
import { nextVoting, readVoting, savedVoting, votingFor } from "../src/realtime/voting.ts";
import type { Voter, VotingState } from "../src/realtime/voting.ts";

const board: Record<string, ElementType> = { a: "sticky", b: "rectangle", c: "frame", line: "arrow", ink: "pen" };
const typeOf = (id: string) => board[id];
const runner: Voter = { id: "runner", canRun: true, typeOf };
const viewer: Voter = { id: "viewer", canRun: false, typeOf };

// Applies events in turn, failing if one is refused.
function apply(state: VotingState | null, ...steps: [Voter, unknown][]): VotingState | null {
  for (const [voter, payload] of steps) {
    const next = nextVoting(state, payload, voter);
    assert.notEqual(next, undefined, `refused: ${JSON.stringify(payload)} from ${voter.id}`);
    state = next!;
  }
  return state;
}

describe("dot voting", () => {
  it("keeps each person's votes to themselves until the round ends", () => {
    const state = apply(
      null,
      [runner, { action: "start", votes: 2 }],
      [runner, { action: "cast", id: "a" }],
      [viewer, { action: "cast", id: "a" }],
      [viewer, { action: "cast", id: "b" }],
    );
    assert.deepEqual(votingFor(state, "viewer"), { open: true, votes: 2, mine: ["a", "b"], voters: 2, results: null });
    assert.deepEqual(votingFor(state, "runner")!.mine, ["a"]);
    assert.deepEqual(votingFor(state, "someone else")!.mine, []);

    const ended = apply(state, [runner, { action: "end" }]);
    assert.deepEqual(votingFor(ended, "anyone")!.results, { a: 2, b: 1 });
    assert.equal(apply(ended, [runner, { action: "clear" }]), null);
  });

  it("gives each person only their votes, one per element, and takes one back", () => {
    let state = apply(null, [runner, { action: "start", votes: 1 }], [viewer, { action: "cast", id: "a" }]);
    assert.equal(nextVoting(state, { action: "cast", id: "a" }, viewer), undefined, "the same element twice");
    assert.equal(nextVoting(state, { action: "cast", id: "b" }, viewer), undefined, "out of votes");
    state = apply(state, [viewer, { action: "retract", id: "a" }], [viewer, { action: "cast", id: "b" }]);
    assert.deepEqual(votingFor(state, "viewer")!.mine, ["b"]);
    assert.equal(nextVoting(state, { action: "retract", id: "a" }, viewer), undefined, "not theirs");
  });

  it("only takes votes on things to choose between, while the round is open", () => {
    const open = apply(null, [runner, { action: "start", votes: 3 }]);
    for (const id of ["line", "ink", "missing", 7]) {
      assert.equal(nextVoting(open, { action: "cast", id }, viewer), undefined, String(id));
    }
    assert.notEqual(nextVoting(open, { action: "cast", id: "c" }, viewer), undefined, "a frame");
    const ended = apply(open, [runner, { action: "end" }]);
    assert.equal(nextVoting(ended, { action: "cast", id: "a" }, viewer), undefined, "ended");
    assert.equal(nextVoting(null, { action: "cast", id: "a" }, viewer), undefined, "no round");
  });

  it("lets only those who can edit run a round", () => {
    assert.equal(nextVoting(null, { action: "start", votes: 3 }, viewer), undefined);
    const open = apply(null, [runner, { action: "start", votes: 3 }]);
    assert.equal(nextVoting(open, { action: "end" }, viewer), undefined);
    assert.equal(nextVoting(open, { action: "clear" }, viewer), undefined);
  });

  it("refuses what isn't a vote", () => {
    for (const payload of [
      null,
      "start",
      {},
      { action: "start", votes: 0 },
      { action: "start", votes: 2.5 },
      { action: "start", votes: 21 },
      { action: "start", votes: "3" },
      { action: "nope" },
    ]) {
      assert.equal(nextVoting(null, payload, runner), undefined, JSON.stringify(payload));
    }
  });
});

describe("a saved round of voting", () => {
  it("reads back as it was saved", () => {
    const state = apply(null, [runner, { action: "start", votes: 2 }], [viewer, { action: "cast", id: "a" }]);
    assert.deepEqual(readVoting(JSON.parse(JSON.stringify(savedVoting(state)))), state);
    assert.equal(savedVoting(null), null);
  });

  it("is none when what was saved isn't one, and keeps only ballots that are", () => {
    for (const saved of [
      null,
      "x",
      {},
      { open: true, votes: 0, ballots: [] },
      { open: "yes", votes: 2, ballots: [] },
    ]) {
      assert.equal(readVoting(saved), null, JSON.stringify(saved));
    }
    const read = readVoting({
      open: true,
      votes: 1,
      ballots: [
        ["p", ["a", "b"]],
        ["q", "a"],
        [3, ["a"]],
      ],
    })!;
    assert.deepEqual([...read.ballots], [["p", new Set(["a"])]]);
  });
});
