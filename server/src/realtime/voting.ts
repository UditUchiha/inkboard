import { MAX_VOTES_PER_PERSON, VOTABLE_TYPES } from "@inkboard/shared/limits";
import type { Voting } from "@inkboard/shared/socket";
import type { ElementType } from "@inkboard/shared/types";

// Dot voting: an editor starts a round, giving each person a few votes to put on elements, one each at most. Each person
// sees only their own votes until the round ends, so nobody follows the crowd. A round is saved with the board.

export type VotingState = { open: boolean; votes: number; ballots: Map<string, Set<string>> };

export type Voter = {
  id: string;
  canRun: boolean;
  typeOf: (id: string) => ElementType | undefined;
};

const VOTABLE = new Set<string | undefined>(VOTABLE_TYPES);

// undefined when the event isn't one (a browser can send anything), isn't the sender's to make, or changes nothing
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

// a Map doesn't save, so votes are [id, element ids] pairs
export type SavedVoting = { open: boolean; votes: number; ballots: [string, string[]][] };

export const savedVoting = (state: VotingState | null): SavedVoting | null =>
  state && { open: state.open, votes: state.votes, ballots: [...state.ballots].map(([id, ids]) => [id, [...ids]]) };

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
