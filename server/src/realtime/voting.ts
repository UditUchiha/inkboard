import { MAX_VOTES_PER_PERSON, VOTABLE_TYPES } from "@inkboard/shared/limits";
import type { Voting } from "@inkboard/shared/socket";
import type { ElementType } from "@inkboard/shared/types";

// Dot voting on a board. Someone who can edit starts a round, giving each person a few votes to put on notes,
// shapes, text, pictures or frames, one each at most. Each person sees only their own votes (and how many people
// have voted) until the round ends, so nobody follows the crowd; then everyone sees the results. A round lives
// with the board's open session and is saved with the board, so it's still there when everyone has left and comes back.

/** A round as the session keeps it: whether it's open, the votes each person has, and each person's votes, by their id. */
export type VotingState = { open: boolean; votes: number; ballots: Map<string, Set<string>> };

/** Who sent a vote event, and what the board holds. */
export type Voter = {
  // The person's id: their account's, or their guest id.
  id: string;
  // Whether they can edit the board, which starting, ending and clearing a round needs.
  canRun: boolean;
  // The type of the element with this id on the board, or undefined if there's none.
  typeOf: (id: string) => ElementType | undefined;
};

const VOTABLE = new Set<string | undefined>(VOTABLE_TYPES);

/**
 * The round after a `vote` event: a new state, null once it's cleared, or undefined when the event isn't one (a
 * browser can send anything), isn't the sender's to make, or changes nothing.
 */
export function nextVoting(state: VotingState | null, payload: unknown, voter: Voter): VotingState | null | undefined {
  if (!payload || typeof payload !== "object") return undefined;
  const { action, votes, id } = payload as { action?: unknown; votes?: unknown; id?: unknown };
  const mine = state?.ballots.get(voter.id) ?? new Set<string>();
  const ballots = (next: Set<string>) => new Map(state!.ballots).set(voter.id, next);
  switch (action) {
    case "start": {
      const count = Number.isInteger(votes) ? (votes as number) : 0;
      const valid = voter.canRun && count >= 1 && count <= MAX_VOTES_PER_PERSON;
      return valid ? { open: true, votes: count, ballots: new Map() } : undefined;
    }
    case "end":
      return voter.canRun && state?.open ? { ...state, open: false } : undefined;
    case "clear":
      return voter.canRun && state ? null : undefined;
    case "cast":
      if (!state?.open || typeof id !== "string" || mine.has(id) || mine.size >= state.votes) return undefined;
      return VOTABLE.has(voter.typeOf(id)) ? { ...state, ballots: ballots(new Set(mine).add(id)) } : undefined;
    case "retract": {
      if (!state?.open || typeof id !== "string" || !mine.has(id)) return undefined;
      const kept = new Set(mine);
      kept.delete(id);
      return { ...state, ballots: ballots(kept) };
    }
    default:
      return undefined;
  }
}

/** The round as the person with this id sees it (see Voting), or null if there's none. */
export function votingFor(state: VotingState | null, voterId: string): Voting | null {
  if (!state) return null;
  const sets = [...state.ballots.values()];
  let results: Record<string, number> | null = null;
  if (!state.open) {
    results = {};
    for (const ids of sets) for (const id of ids) results[id] = (results[id] ?? 0) + 1;
  }
  return {
    open: state.open,
    votes: state.votes,
    mine: [...(state.ballots.get(voterId) ?? [])],
    voters: sets.filter((ids) => ids.size > 0).length,
    results,
  };
}

/** A round as it's saved with the board: each person's votes as [their id, element ids] (a Map doesn't save). */
export type SavedVoting = { open: boolean; votes: number; ballots: [string, string[]][] };

export const savedVoting = (state: VotingState | null): SavedVoting | null =>
  state && { open: state.open, votes: state.votes, ballots: [...state.ballots].map(([id, ids]) => [id, [...ids]]) };

/** A round as it was saved with the board, or null if what's there isn't one. Ballots that aren't any are left out. */
export function readVoting(saved: unknown): VotingState | null {
  if (!saved || typeof saved !== "object") return null;
  const { open, votes, ballots } = saved as { open?: unknown; votes?: unknown; ballots?: unknown };
  if (typeof open !== "boolean" || !Number.isInteger(votes)) return null;
  if (!((votes as number) >= 1 && (votes as number) <= MAX_VOTES_PER_PERSON) || !Array.isArray(ballots)) return null;
  const kept = new Map<string, Set<string>>();
  for (const ballot of ballots) {
    if (!Array.isArray(ballot) || typeof ballot[0] !== "string" || !Array.isArray(ballot[1])) continue;
    const ids = (ballot[1] as unknown[]).filter((id): id is string => typeof id === "string");
    kept.set(ballot[0], new Set(ids.slice(0, votes as number)));
  }
  return { open, votes: votes as number, ballots: kept };
}
