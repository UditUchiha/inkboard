import assert from "node:assert/strict";
import { register } from "node:module";
import { describe, it } from "node:test";
import type { Voting } from "@inkboard/shared/socket";
import type { Element } from "@inkboard/shared/types";
import { createElement } from "react";
import { renderToStaticMarkup } from "react-dom/server";

register("./jsx-hooks.js", import.meta.url);
const { VotingBar, voteFor, voteTarget } = await import("../src/features/board/Voting.tsx");

const note = {
  id: "note",
  type: "sticky",
  x1: 0,
  y1: 0,
  x2: 100,
  y2: 100,
  text: "",
  fill: "#ffec99",
  font: "hand",
} as Element;
const other = { ...note, id: "other" } as Element;
const stroke = {
  id: "ink",
  type: "pen",
  points: [[0, 0, 0.5]],
  pressure: false,
  stroke: "#000",
  penSize: 4,
} as Element;
const round = (mine: string[], votes = 2): Voting => ({ open: true, votes, mine, voters: 1, results: null });

describe("voting", () => {
  it("casts a vote, or takes back one already cast", () => {
    assert.deepEqual(voteFor(round([]), note), { action: "cast", id: "note" });
    assert.deepEqual(voteFor(round(["note"]), note), { action: "retract", id: "note" });
  });

  it("says why a vote can't be cast", () => {
    assert.ok("refused" in voteFor(round([]), stroke)!);
    assert.match((voteFor(round(["other"], 1), note) as { refused: string }).refused, /used all your votes/);
    assert.deepEqual(
      voteFor(round(["other"], 1), other),
      { action: "retract", id: "other" },
      "taking one back is fine",
    );
  });

  it("votes on what a click is inside, not only what it touches", () => {
    const box = {
      id: "box",
      type: "rectangle",
      x1: 0,
      y1: 0,
      x2: 100,
      y2: 100,
      seed: 1,
      stroke: "#000",
      fill: null,
      strokeWidth: 2,
      sketchy: false,
    } as Element;
    const frame = { id: "frame", type: "frame", x1: -50, y1: -50, x2: 300, y2: 300, name: "F" } as Element;
    const board = [frame, box, stroke];
    assert.equal(voteTarget(board, { x: 50, y: 50 }, null)?.id, "box", "inside an outlined shape");
    assert.equal(voteTarget(board, { x: 2, y: 2 }, stroke)?.id, "box", "a stroke over it");
    assert.equal(voteTarget(board, { x: 200, y: 200 }, null)?.id, "frame", "only the frame");
    assert.equal(voteTarget([stroke], { x: 0, y: 0 }, stroke)?.id, "ink", "kept, to say why not");
    assert.equal(voteTarget([], { x: 0, y: 0 }, null), null);
  });

  it("does nothing outside an open round", () => {
    assert.equal(voteFor(null, note), null);
    assert.equal(voteFor({ ...round([]), open: false, results: {} }, note), null);
  });

  it("shows votes left while open, and lets only the one running it end it", () => {
    const props = { voteToolOn: true, onVoteTool: () => {}, onEnd: () => {}, onClear: () => {} };
    const voter = renderToStaticMarkup(
      createElement(VotingBar, { voting: round(["note"], 3), canRun: false, ...props }),
    );
    assert.match(voter, /2 of 3 votes left/);
    assert.doesNotMatch(voter, /Show results|Cancel voting/);
    const runner = renderToStaticMarkup(createElement(VotingBar, { voting: round([], 3), canRun: true, ...props }));
    assert.match(runner, /Show results.*Cancel voting/);
    const ended = { ...round([], 3), open: false, voters: 4, results: { note: 3 } };
    assert.match(
      renderToStaticMarkup(createElement(VotingBar, { voting: ended, canRun: true, ...props })),
      /Results: 4 people voted.*Clear results/,
    );
  });
});
