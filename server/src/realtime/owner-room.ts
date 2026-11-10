import { roomLeft } from "../services/boards.ts";
import { getSession } from "./sessions.ts";
import type { Session } from "./sessions.ts";

// How much space a board's owner has left, looked up lazily and kept per owner.

// A change growing a board past its owner's remaining space (BOARD_LIMITS) is refused. Summing an owner's space reads
// all their boards, versions and templates, so it's done at most this often per owner, and growth since is subtracted.
const ROOM_CHECK_MS = 30_000;
// before refusing for space, a figure older than this is looked up again (the owner may have made room)
export const ROOM_REFRESH_MS = 3_000;
// after a failed lookup, the next change retries once this long has passed
const ROOM_RETRY_MS = 2_000;

// owner id -> last looked-up room (at `at`), the lookup under way, and the owner's open boards, which tell whether
// anything has kept the figure current since
const owners = new Map<string, OwnerEntry>();

interface OwnerEntry {
  room: number | undefined;
  at: number;
  pending: Promise<void> | null;
  boards: Map<string, Session>;
}

export function ownerEntry(owner: string) {
  let entry = owners.get(owner);
  if (!entry) {
    // drop owners with nothing open, so the map doesn't grow with every owner ever seen
    if (owners.size > 1000) {
      for (const [id, other] of owners) if (!other.pending && Date.now() - other.at >= ROOM_CHECK_MS) owners.delete(id);
    }
    entry = { room: undefined, at: 0, pending: null, boards: new Map() };
    owners.set(owner, entry);
  }
  return entry;
}

// never rejects
export function lookUpRoom(owner: string) {
  const entry = ownerEntry(owner);
  entry.pending ??= roomLeft(owner)
    .then(
      (left) => {
        entry.room = left;
        entry.at = Date.now();
      },
      (error: Error) => {
        // keep the old figure and retry on the next change
        entry.at = Date.now() - ROOM_CHECK_MS + ROOM_RETRY_MS;
        console.error(`Could not add up the space used by ${owner}: ${error.message}`);
      },
    )
    .finally(() => {
      entry.pending = null;
    });
  return entry.pending;
}

// Waits for the lookup unless a recent figure exists, so the first change has one. A figure kept while none of the
// owner's boards were open is dropped: nothing kept it current.
export async function openOwner(session: Session) {
  if (!session.owner) return;
  const entry = ownerEntry(session.owner);
  for (const [id, open] of entry.boards) if (getSession(id) !== open) entry.boards.delete(id);
  if (entry.boards.size === 0) entry.at = 0;
  entry.boards.set(session.boardId, session);
  if (Date.now() - entry.at >= ROOM_CHECK_MS) await lookUpRoom(session.owner);
}

// Infinity when unknown (no owner, or no lookup has worked yet): failing open for a change or two beats refusing
// everything while the database is slow.
export function ownerRoom(session: Session) {
  if (!session.owner) return Infinity;
  const entry = ownerEntry(session.owner);
  if (!entry.pending && Date.now() - entry.at >= ROOM_CHECK_MS) lookUpRoom(session.owner);
  return entry.room ?? Infinity;
}
