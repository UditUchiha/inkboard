import { commitPlan } from "@inkboard/shared/board-merge";
import { inStackOrder } from "@inkboard/shared/board-order";
import { withDefaults } from "@inkboard/shared/element-rules";
import { MAX_REMOVALS_REMEMBERED } from "@inkboard/shared/limits";
import type { RemovedStamp } from "@inkboard/shared/socket";
import type { Effect, Element, Plan, Stamp, Tombstone, Tombstones } from "@inkboard/shared/types";
import mongoose from "mongoose";
import { Board } from "../models/board.model.ts";
import type { ObjectIdLike } from "../services/boards.ts";
import { diffElements, hasReplay, recordStep, REPLAY_LIMITS } from "../services/replay.ts";
import { lastVersionTime, recordVersion } from "../services/versions.ts";
import { readClassroom, savedClassroom } from "./classroom.ts";
import type { ClassroomState } from "./classroom.ts";
import { readCountdown } from "./countdown.ts";
import type { CountdownState } from "./countdown.ts";
import { elementBytes, MAX_BOARD_BYTES, MAX_ELEMENT_BYTES, MAX_ELEMENTS_PER_BOARD, restoreOver } from "./operations.ts";
import { readSuggestions, settleSuggestions, suggestionList } from "./suggestions.ts";
import type { SuggestionState } from "./suggestions.ts";
import { readVoting, savedVoting } from "./voting.ts";
import type { VotingState } from "./voting.ts";

// Open boards live in memory so every stroke broadcasts immediately, and are written to MongoDB shortly after a change.
// Saving costs time in proportion to board size (about 0.4 s per 2 MB), so bigger boards wait longer between saves,
// or a busy one would spend all its time saving. A crash loses what wasn't written yet, hence small boards save fast.
const BASE_PERSIST_DELAY_MS = 250;
const MAX_PERSIST_DELAY_MS = 5000;
const BYTES_PER_EXTRA_MS = 4000;

const persistDelay = (session: Session) =>
  Math.min(MAX_PERSIST_DELAY_MS, BASE_PERSIST_DELAY_MS + Math.round(session.bytes / BYTES_PER_EXTRA_MS));

// the first change after a quiet spell this long saves the board as a version: a checkpoint from before each burst of
// work
const CHECKPOINT_INTERVAL_MS = 10 * 60 * 1000;
const SKIP_WARNING_INTERVAL_MS = 60 * 60 * 1000;

export interface Session {
  boardId: string;
  // null for a board without an owner (see ownerRoom in owner-room.ts)
  owner: string | null;
  elements: Element[];
  index: Map<string, Element>;
  sizes: Map<string, number>;
  bytes: number;
  // stamp each removal was made with (and its last data, within MAX_BURIED_BYTES), when it happened, and the bytes of
  // data the tombstones keep, oldest first
  tombstones: Tombstones;
  removedAt: Map<string, number>;
  buried: Map<string, number>;
  buriedBytes: number;
  suggestions: SuggestionState;
  suggestionsDirty: boolean;
  voting: VotingState | null;
  facilitationDirty: boolean;
  // changes not saved yet, the save (or its retry) that's due, and the save in progress
  dirty: boolean;
  timer: ReturnType<typeof setTimeout> | null;
  saving: Promise<void> | null;
  closing: boolean;
  discarded: boolean;
  // null until the lookup in openSession finishes; skipWarnedAt is when the log last said a checkpoint was skipped
  lastVersionAt: number | null;
  skipWarnedAt: number | null;
  // the elements as the replay's last step left them (null until the lookup in openSession finishes), and the step due
  recorded: Map<string, Element> | null;
  stepTimer: ReturnType<typeof setTimeout> | null;
  countdown: CountdownState | null;
  privateMode: PrivateModeState | null;
  classroom: ClassroomState | null;
}

type SavedRemoval = Stamp & { id: string; at: number };

const sessions = new Map<string, Session>();

export function getSession(boardId: string) {
  return sessions.get(boardId);
}

// boards being opened right now, so people opening one together share a single read
const opening = new Map<string, Promise<Session>>();

// Reads the board after any earlier session for it has finished saving, so it's never older than what people last saw.
// The caller must join the board in the same turn (see enterBoard), or it could be closed before they do.
export function acquireSession(boardId: string): Promise<Session> {
  const open = sessions.get(boardId);
  if (open) return Promise.resolve(open);
  let pending = opening.get(boardId);
  if (!pending) {
    pending = Board.findById(boardId)
      .select("elements removed suggestions owner countdown voting privateMode classroom")
      .lean()
      .then((saved) =>
        openSession(boardId, saved?.elements ?? [], saved?.removed, saved?.owner, saved?.suggestions, saved ?? {}),
      )
      .finally(() => opening.delete(boardId));
    opening.set(boardId, pending);
  }
  return pending;
}

// Call right after `acquireSession`, in the same turn, and acquire again when this says no: it closed (and saved)
// between.
export function holdSession(session: Session) {
  if (sessions.get(session.boardId) !== session) return false;
  session.closing = false;
  return true;
}

// An Unmeasured session is one openSession made, before it is measured.
type Unmeasured = Omit<Session, "index" | "sizes" | "bytes"> & Partial<Pick<Session, "index" | "sizes" | "bytes">>;

function measure(session: Unmeasured): asserts session is Session {
  session.index = new Map(session.elements.map((element) => [element.id, element]));
  session.sizes = new Map(session.elements.map((element) => [element.id, elementBytes(element)]));
  session.bytes = [...session.sizes.values()].reduce((sum, size) => sum + size, 0);
}

// Returns null when the change fits, or why not: "element" (one is too big), "board" (it would be too big) or "owner"
// (it would grow the board by more than `room`). Changes that don't grow a board are always accepted. `buried` changes
// to
// removed elements don't add to the board, but each must fit as an element, since it's passed on and could come back.
// When it fits, size tracking is updated, so call updateSession with the same change next.
export function admit(
  session: Session,
  op: Effect,
  buried: Element[] = [],
  room = Infinity,
): "element" | "board" | "owner" | null {
  if (buried.some((element) => elementBytes(element) > MAX_ELEMENT_BYTES)) return "element";
  const updates = new Map(op.upsert.map((element) => [element.id, elementBytes(element)]));
  const removals = new Set(op.remove.map((removal) => removal.id).filter((id) => !updates.has(id)));

  let bytes = session.bytes;
  for (const [id, size] of updates) {
    if (size > MAX_ELEMENT_BYTES) return "element";
    bytes += size - (session.sizes.get(id) ?? 0);
  }
  for (const id of removals) bytes -= session.sizes.get(id) ?? 0;
  if (bytes > MAX_BOARD_BYTES && bytes > session.bytes) return "board";
  if (bytes - session.bytes > Math.max(0, room)) return "owner";

  for (const [id, size] of updates) session.sizes.set(id, size);
  for (const id of removals) session.sizes.delete(id);
  session.bytes = bytes;
  return null;
}

// removed elements keep their last data up to this much (see shared/src/board-merge.ts); past it the oldest keep only
// their stamp, which still stops older changes bringing them back
const MAX_BURIED_BYTES = MAX_BOARD_BYTES;

// Tombstone stamps are also saved with the board, so a change made long ago by someone offline can't bring back what
// was
// removed since. An open board keeps up to MAX_REMOVED_IN_MEMORY (as many as browsers keep), so a long session loses
// none early.
export const REMOVED_LIMITS = { ageMs: 30 * 24 * 3600 * 1000, count: MAX_ELEMENTS_PER_BOARD };
const MAX_REMOVED_IN_MEMORY = MAX_REMOVALS_REMEMBERED;

const isStampNumber = (value: number, max = Number.MAX_SAFE_INTEGER) =>
  Number.isSafeInteger(value) && value >= 0 && value <= max;

export function readRemoved(removed: SavedRemoval[] | undefined, elements: Element[]) {
  const live = new Set(elements.map((element) => element.id));
  const cutoff = Date.now() - REMOVED_LIMITS.ageMs;
  const entries = (Array.isArray(removed) ? removed : [])
    .filter(
      (entry) =>
        typeof entry?.id === "string" &&
        !live.has(entry.id) &&
        isStampNumber(entry.version) &&
        isStampNumber(entry.versionNonce, 2 ** 31 - 1) &&
        Number.isFinite(entry.at) &&
        entry.at > cutoff,
    )
    .sort((a, b) => a.at - b.at)
    .slice(-REMOVED_LIMITS.count);
  return {
    tombstones: new Map(entries.map(({ id, version, versionNonce }) => [id, { version, versionNonce }])),
    removedAt: new Map(entries.map(({ id, at }) => [id, at])),
  };
}

function removedList(session: Session) {
  const cutoff = Date.now() - REMOVED_LIMITS.ageMs;
  const recent = [...session.removedAt].filter(([, at]) => at > cutoff).slice(-REMOVED_LIMITS.count);
  return recent.map(([id, at]) => {
    const { version, versionNonce } = session.tombstones.get(id)!;
    return { id, version, versionNonce, at };
  });
}

function trimRemoved(session: Session) {
  let excess = session.removedAt.size - MAX_REMOVED_IN_MEMORY;
  for (const id of session.removedAt.keys()) {
    if (excess-- <= 0) break;
    forget(session, id);
  }
}

export function removedStamps(tombstones: Tombstones): RemovedStamp[] {
  return [...tombstones].map(([id, { version, versionNonce }]) => ({ id, version, versionNonce }));
}

function forget(session: Session, id: string) {
  session.tombstones.delete(id);
  session.removedAt.delete(id);
  session.buriedBytes -= session.buried.get(id) ?? 0;
  session.buried.delete(id);
}

export type PrivateModeState = { by: string; name: string };

function readPrivateMode(saved: unknown): PrivateModeState | null {
  const { by, name } = (saved ?? {}) as Partial<PrivateModeState>;
  return typeof by === "string" && typeof name === "string" ? { by, name } : null;
}

function openSession(
  boardId: string,
  elements: Element[],
  removed: SavedRemoval[] = [],
  owner: ObjectIdLike | null = null,
  suggestions: unknown = [],
  {
    countdown = null,
    voting = null,
    privateMode = null,
    classroom = null,
  }: { countdown?: unknown; voting?: unknown; privateMode?: unknown; classroom?: unknown } = {},
): Session {
  // boards saved before elements had stack places or every field of their kind get them now (see withDefaults)
  const ordered = inStackOrder(elements.map(withDefaults));
  const session: Unmeasured = {
    boardId,
    owner: owner ? String(owner) : null,
    elements: ordered,
    ...readRemoved(removed, ordered),
    buried: new Map(),
    buriedBytes: 0,
    suggestions: readSuggestions(suggestions),
    suggestionsDirty: false,
    voting: readVoting(voting),
    facilitationDirty: false,
    dirty: false,
    timer: null,
    saving: null,
    closing: false,
    discarded: false,
    lastVersionAt: null,
    skipWarnedAt: null,
    recorded: null,
    stepTimer: null,
    countdown: readCountdown(countdown),
    privateMode: readPrivateMode(privateMode),
    classroom: readClassroom(classroom),
  };
  measure(session);
  // suggestions the board overtook while closed (or that are too old) go now, before anyone sees them
  const settled = settleSuggestions(session.suggestions, session);
  if (settled.accepted.length + settled.gone.length > 0) markSuggestionsDirty(session);
  sessions.set(boardId, session);
  lastVersionTime(boardId)
    .then((time) => {
      session.lastVersionAt ??= time;
    })
    .catch(() => {});
  // a board with a replay was saved as its last step left it; one without starts with its first step, the whole board
  const opened = new Map(session.index);
  hasReplay(boardId)
    .then((has) => {
      session.recorded ??= has ? opened : new Map();
    })
    .catch(() => {});
  return session;
}

// at most one step per REPLAY_LIMITS.stepMs while people work, and one more when the board is saved to close
function scheduleStep(session: Session) {
  session.stepTimer ??= setTimeout(() => takeStep(session), REPLAY_LIMITS.stepMs);
}

// a failed step is only logged: a replay is worth less than a save
async function takeStep(session: Session) {
  clearTimeout(session.stepTimer!);
  session.stepTimer = null;
  if (session.discarded) return;
  if (!session.recorded) return scheduleStep(session);
  const { step, next } = diffElements(session.recorded, session.elements);
  session.recorded = next;
  if (!step) return;
  try {
    await recordStep(session.boardId, step);
  } catch (error) {
    console.error(`Could not record a replay step of board ${session.boardId}: ${(error as Error).message}`);
  }
}

function checkpoint(session: Session) {
  // unknown until the lookup in openSession finishes; skip rather than guess
  if (session.lastVersionAt === null) return;
  if (Date.now() - session.lastVersionAt < CHECKPOINT_INTERVAL_MS) return;
  if (session.elements.length === 0) return;
  session.lastVersionAt = Date.now();
  recordVersion(session.boardId, session.elements)
    .then((version) => version === null && warnCheckpointSkipped(session))
    .catch((error: Error) => console.error(`Could not save a version of board ${session.boardId}: ${error.message}`));
}

// A skipped autosave means saved versions have no room for one (see recordVersion), so history quietly stops growing.
// Say so in the log, at most once an hour per board.
function warnCheckpointSkipped(session: Session) {
  const now = Date.now();
  if (now - (session.skipWarnedAt ?? 0) < SKIP_WARNING_INTERVAL_MS) return;
  session.skipWarnedAt = now;
  console.warn(
    `Skipped the automatic version of board ${session.boardId}: its saved versions leave no room in its history budget.`,
  );
}

export function updateSession(session: Session, plan: Plan): string[] {
  const changes = plan.shown.size > 0 || plan.hidden.size > 0;
  if (changes) checkpoint(session);
  const { elements, dropped } = commitPlan(plan, session.tombstones, { limit: MAX_ELEMENTS_PER_BOARD });
  session.elements = elements;
  for (const id of dropped) {
    session.bytes -= session.sizes.get(id) ?? 0;
    session.sizes.delete(id);
  }
  bury(session, plan.graves);
  const now = Date.now();
  for (const [id, tombstone] of plan.graves) {
    if (!tombstone) session.removedAt.delete(id);
    else if (plan.hidden.has(id)) {
      session.removedAt.delete(id); // re-set below so the map stays oldest first
      session.removedAt.set(id, now);
    }
  }
  trimRemoved(session);
  if (changes) markDirty(session);
  return dropped;
}

function bury(session: Session, graves: Iterable<readonly [string, Tombstone | null]>) {
  for (const [id, tombstone] of graves) {
    session.buriedBytes -= session.buried.get(id) ?? 0;
    session.buried.delete(id);
    if (tombstone?.element) {
      const bytes = elementBytes(tombstone.element);
      session.buried.set(id, bytes);
      session.buriedBytes += bytes;
    }
  }
  for (const [id, bytes] of session.buried) {
    if (session.buriedBytes <= MAX_BURIED_BYTES) break;
    const { element: _data, ...stamp } = session.tombstones.get(id)!;
    session.tombstones.set(id, stamp);
    session.buried.delete(id);
    session.buriedBytes -= bytes;
  }
}

function dateRestored(removedAt: Map<string, number>, before: Set<string>, tombstones: Tombstones, now: number) {
  for (const id of removedAt.keys()) if (!tombstones.has(id)) removedAt.delete(id);
  for (const id of tombstones.keys()) if (!before.has(id)) removedAt.set(id, now);
}

export function resetSession(session: Session, snapshot: Element[]): Element[] {
  const now = Date.now();
  const before = new Set(session.tombstones.keys());
  const { elements, tombstones } = restoreOver(session.elements, session.tombstones, snapshot);
  session.elements = elements;
  session.tombstones = tombstones;
  dateRestored(session.removedAt, before, tombstones, now);
  session.buried = new Map();
  session.buriedBytes = 0;
  bury(
    session,
    [...tombstones].filter(([id]) => !before.has(id)),
  );
  measure(session);
  session.lastVersionAt = now;
  markDirty(session);
  return elements;
}

function markDirty(session: Session) {
  session.dirty = true;
  scheduleStep(session);
  session.timer ??= setTimeout(() => persist(session), persistDelay(session));
}

export function markSuggestionsDirty(session: Session) {
  session.suggestionsDirty = true;
  session.timer ??= setTimeout(() => persist(session), BASE_PERSIST_DELAY_MS);
}

export function markFacilitationDirty(session: Session) {
  session.facilitationDirty = true;
  session.timer ??= setTimeout(() => persist(session), BASE_PERSIST_DELAY_MS);
}

// One save at a time per board, so an older copy can't land after a newer one: changes made during a save go in the
// next
// round of the same save, and callers share the one promise.
function persist(session: Session) {
  clearTimeout(session.timer!); // clearTimeout accepts null, which Node's types omit
  session.timer = null;
  session.saving ??= save(session).finally(() => {
    session.saving = null;
  });
  return session.saving;
}

async function save(session: Session) {
  while ((session.dirty || session.suggestionsDirty || session.facilitationDirty) && !session.discarded) {
    const { dirty, suggestionsDirty, facilitationDirty } = session;
    session.dirty = false;
    session.suggestionsDirty = false;
    session.facilitationDirty = false;
    try {
      // the plain driver is 2-3x faster than Mongoose for a big elements array, so updatedAt is kept current by hand;
      // only
      // what changed is written (suggestions change often and don't change the board)
      await Board.collection.updateOne(
        { _id: new mongoose.Types.ObjectId(session.boardId) },
        {
          $set: {
            ...(dirty
              ? {
                  elements: session.elements,
                  removed: removedList(session),
                  // measured as boards are (drawingBytes in services/boards.ts), which adds up a little differently
                  // from session.bytes
                  bytes: mongoose.mongo.BSON.calculateObjectSize({ elements: session.elements }),
                  updatedAt: new Date(),
                }
              : {}),
            ...(suggestionsDirty ? { suggestions: suggestionList(session.suggestions) } : {}),
            ...(facilitationDirty
              ? {
                  countdown: session.countdown,
                  voting: savedVoting(session.voting),
                  privateMode: session.privateMode,
                  classroom: savedClassroom(session.classroom),
                }
              : {}),
          },
        },
      );
    } catch (error) {
      console.error(`Could not save board ${session.boardId}: ${(error as Error).message}`);
      session.dirty ||= dirty;
      session.suggestionsDirty ||= suggestionsDirty;
      session.facilitationDirty ||= facilitationDirty;
      if (!session.discarded) session.timer ??= setTimeout(() => persist(session), MAX_PERSIST_DELAY_MS);
      return;
    }
  }
  // saved, and nobody came back to it meanwhile: it can go
  const unsaved = session.dirty || session.suggestionsDirty || session.facilitationDirty;
  if (session.closing && !unsaved && sessions.get(session.boardId) === session) {
    sessions.delete(session.boardId);
  }
}

export async function closeSession(boardId: string) {
  const session = sessions.get(boardId);
  if (!session) return;
  session.closing = true;
  await Promise.all([session.stepTimer && takeStep(session), persist(session)]);
}

export function discardSession(boardId: string) {
  const session = sessions.get(boardId);
  if (!session) return;
  session.discarded = true;
  clearTimeout(session.timer!);
  clearTimeout(session.stepTimer!);
  session.timer = null;
  session.stepTimer = null;
  sessions.delete(boardId);
}

export function flushAllSessions() {
  return Promise.all(
    [...sessions.values()].flatMap((session) => [session.stepTimer && takeStep(session), persist(session)]),
  );
}
