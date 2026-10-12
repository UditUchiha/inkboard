import { inStackOrder } from "@inkboard/shared/board-order";
import { withDefaults } from "@inkboard/shared/element-rules";
import type { ReplayStep } from "@inkboard/shared/socket";
import type { Element as BoardElement } from "@inkboard/shared/types";
import { getBounds } from "./elements";
import { unionRects } from "./geometry";
import type { Rect } from "./geometry";

// Every this many steps the board is kept whole, so going to any step applies at most this many.
const CHECKPOINT_EVERY = 50;

/** A replay as it's watched: how many frames it has, the board at each, when each was, and where to look. */
export type Replay = {
  length: number;
  frameAt: (index: number) => BoardElement[];
  timeAt: (index: number) => number | null;
  // Everything ever drawn in the replay, so the view stays put while it plays.
  bounds: Rect | null;
};

function apply(board: Map<string, BoardElement>, step: ReplayStep) {
  for (const id of step.remove) board.delete(id);
  for (const element of step.upsert) board.set(element.id, element);
}

/**
 * The frames of a board's replay: the board after each step, then the board as it is now (`now`), which a step
 * still to be recorded may not have reached yet.
 */
export function createReplay(steps: ReplayStep[], now: BoardElement[]): Replay {
  const checkpoints: Map<string, BoardElement>[] = [];
  const board = new Map<string, BoardElement>();
  steps.forEach((step, index) => {
    if (index % CHECKPOINT_EVERY === 0) checkpoints.push(new Map(board));
    apply(board, step);
  });
  const drawn = [...steps.flatMap((step) => step.upsert), ...now];
  return {
    length: steps.length + 1,
    frameAt(index) {
      if (index >= steps.length) return now;
      const start = index - (index % CHECKPOINT_EVERY);
      const frame = new Map(checkpoints[start / CHECKPOINT_EVERY]);
      for (let at = start; at <= index; at += 1) apply(frame, steps[at]);
      return inStackOrder([...frame.values()].map(withDefaults));
    },
    timeAt: (index) => steps[index]?.at ?? null,
    bounds: unionRects(drawn.map(getBounds)),
  };
}
