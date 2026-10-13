import { VOTABLE_TYPES } from "@inkboard/shared/limits";
import type { Voting } from "@inkboard/shared/socket";
import type { Element as BoardElement } from "@inkboard/shared/types";
import clsx from "clsx";
import { Check, Vote, X } from "lucide-react";
import { Button, IconButton } from "../../components/Button";
import { Menu, MenuItem, MenuLabel } from "../../components/Menu";
import { getBounds } from "./elements";
import { rectContains, toScreen } from "./geometry";
import type { Viewport, XY } from "./geometry";

// Dot voting (see server/src/realtime/voting.ts): someone who can edit starts a round, everyone on the board puts
// their votes on notes, shapes, text, pictures or frames, and when the round ends everyone sees the counts.

const VOTE_CHOICES = [1, 3, 5, 10];

/** Whether an element can be voted on. */
export const isVotable = (element: BoardElement): boolean => VOTABLE_TYPES.includes(element.type);

/**
 * What a click at `point` with the vote tool is for: the element hit if it can be voted on, or else the topmost one
 * whose box holds the point, so a click inside an outlined shape counts, a frame only when nothing in it does. The
 * element hit is kept otherwise, to say why it can't be voted on.
 */
export function voteTarget(
  elements: readonly BoardElement[],
  point: XY,
  hit: BoardElement | null,
): BoardElement | null {
  if (hit && isVotable(hit)) return hit;
  const inside = elements.filter((element) => isVotable(element) && rectContains(getBounds(element), point.x, point.y));
  return inside.findLast((element) => element.type !== "frame") ?? inside.at(-1) ?? hit;
}

/** What a click on an element with the vote tool does: cast a vote, take one back, or nothing (with why). */
export function voteFor(
  voting: Voting | null,
  element: BoardElement,
): { action: "cast" | "retract"; id: string } | { refused: string } | null {
  if (!voting?.open) return null;
  if (voting.mine.includes(element.id)) return { action: "retract", id: element.id };
  if (!isVotable(element)) return { refused: "Vote on notes, shapes, text, pictures or frames." };
  if (voting.mine.length >= voting.votes) {
    return { refused: "You've used all your votes. Click one of yours to take it back." };
  }
  return { action: "cast", id: element.id };
}

/** The button that starts a round of voting, for those who can edit the board. */
export function StartVoting({ onStart }: { onStart: (votes: number) => void }) {
  return (
    <Menu side="top" trigger={(props) => <IconButton label="Start voting" icon={Vote} {...props} />}>
      <MenuLabel>Start dot voting</MenuLabel>
      {VOTE_CHOICES.map((votes) => (
        <MenuItem key={votes} onSelect={() => onStart(votes)}>
          {votes} {votes === 1 ? "vote" : "votes"} each
        </MenuItem>
      ))}
    </Menu>
  );
}

/** What the voting bar takes: the round, whether this person runs it, and whether the vote tool is picked. */
export type VotingBarProps = {
  voting: Voting;
  canRun: boolean;
  voteToolOn: boolean;
  onVoteTool: () => void;
  onEnd: () => void;
  onClear: () => void;
};

/** The round of voting under way, under the toolbar: votes left and how many have voted, or the results' summary. */
export function VotingBar({ voting, canRun, voteToolOn, onVoteTool, onEnd, onClear }: VotingBarProps) {
  const left = voting.votes - voting.mine.length;
  const people = `${voting.voters} ${voting.voters === 1 ? "person" : "people"} voted`;
  return (
    <div className="floating-panel flex h-10 items-center gap-2 rounded-xl pr-1 pl-3 text-sm" aria-live="polite">
      <Vote className="size-4 shrink-0" strokeWidth={1.75} aria-hidden />
      {voting.open ? (
        <>
          <span className="font-medium">
            {left} of {voting.votes} {voting.votes === 1 ? "vote" : "votes"} left
          </span>
          <span className="text-graphite max-sm:hidden">· {people}</span>
          {!voteToolOn && (
            <Button size="sm" variant="secondary" onClick={onVoteTool}>
              Vote
            </Button>
          )}
          {canRun && (
            <Button size="sm" onClick={onEnd}>
              Show results
            </Button>
          )}
        </>
      ) : (
        <span className="font-medium">Results: {people}</span>
      )}
      {canRun && (
        <IconButton size="sm" label={voting.open ? "Cancel voting" : "Clear results"} icon={X} onClick={onClear} />
      )}
      {!canRun && !voting.open && <span className="w-2" />}
    </div>
  );
}

/** What the vote badges take: the round, the board's elements and the view they're drawn in. */
export type VotesLayerProps = { voting: Voting; elements: readonly BoardElement[]; viewport: Viewport };

/**
 * A badge at the top right of each element voted on: a tick on this person's own votes while the round is open,
 * then the count each got, the most voted standing out.
 */
export function VotesLayer({ voting, elements, viewport }: VotesLayerProps) {
  const counts: Record<string, number> = voting.results ?? Object.fromEntries(voting.mine.map((id) => [id, 1]));
  const top = Math.max(0, ...Object.values(counts));
  const byId = new Map(elements.map((element) => [element.id, element]));
  return (
    <div className="pointer-events-none absolute inset-0 overflow-hidden" aria-hidden>
      {Object.entries(counts).map(([id, count]) => {
        const element = byId.get(id);
        if (!element) return null;
        const bounds = getBounds(element);
        const corner = toScreen(viewport, bounds.x + bounds.width, bounds.y);
        const winner = voting.results && count === top;
        return (
          <span
            key={id}
            className={clsx(
              "absolute top-0 left-0 grid h-6 min-w-6 place-items-center rounded-full px-1.5 text-xs font-semibold shadow-md ring-2 ring-surface",
              winner ? "bg-marker text-[#16213a]" : "bg-signal text-white",
            )}
            style={{ transform: `translate(${corner.x}px, ${corner.y}px) translate(-50%, -50%)` }}
          >
            {voting.results ? count : <Check className="size-3.5" strokeWidth={3} />}
          </span>
        );
      })}
    </div>
  );
}
