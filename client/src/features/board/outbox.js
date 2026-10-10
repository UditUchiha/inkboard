import { stampOf } from "@inkboard/shared/board-merge";
import { newId } from "./elements";
import { toOperation, toOperations } from "./store";

// The changes made here that the server hasn't confirmed yet (see useBoardSync).
// It has no idea of sockets or React, so what it does with each reply can be
// tested on its own.
//
// A change is queued (`add`), then sent (`take`; a big one in pieces, one at a
// time, all carrying the same `group` so the server takes them in together or not
// at all), and each reply (`settle`) says what to do next: carry on, send it
// again, or give up and show the board as the server has it. Changes for an id
// that were superseded by a newer one are never sent again.
//
// While a change is going out in pieces nothing else is sent: later changes wait
// in the queue until its last piece is answered. The server holds one group per
// connection and takes changes in the order they come, so a removal sent in the
// middle of a big upload would otherwise be taken in first, then undone by it.

// How long changes are gathered before they're sent. A stroke is sent whole each time (its points
// are one field), so the longer it gets, the less often it is: the traffic for a stroke stays about
// the same however long it is drawn, instead of growing with every point.
const FLUSH_INTERVAL_MS = 40;
const FLUSH_MS_PER_POINT = 0.4;
const MAX_EXTRA_FLUSH_MS = 400;

// How long to wait before sending again, by why it didn't go through ("expired": the
// server stopped waiting for the rest of a change sent in pieces).
export const RETRY_DELAY_MS = { timeout: 400, rate: 1000, expired: 0 };

// A change the server keeps answering "rate" to (it's limiting this connection, or holding as much as it
// will of what people are sending) is sent again from its first piece each time, so the wait doubles up to
// MAX_RATE_DELAY_MS, with some jitter so connections that were limited together don't all return together,
// and starts over after a change goes through. After SLOW_AFTER refusals in a row `slow` is set on the
// retry, so the screen can say saving is taking a while.
const MAX_RATE_DELAY_MS = 30_000;
const SLOW_AFTER = 3;

// The stamps the elements of `batch`'s answered pieces were sent with, by id.
function sentStamps(batch) {
  const stamps = new Map();
  for (const { op } of batch.sent) for (const element of op.upsert) stamps.set(element.id, stampOf(element));
  return stamps;
}

export function createOutbox({ onChange = () => {}, random = Math.random } = {}) {
  const pending = new Map(); // id -> element | { removal }, not sent yet
  const lastSent = new Map(); // id -> sequence number of the last piece that included it
  const inflight = new Map(); // sequence number -> { op, rest, batch }: sent, no reply yet
  // batch: { group: { id, total } | null, started, sent: [{ op, seq }], failed }: how many of a change's
  // pieces were sent, those already answered, and whether one of them wasn't saved
  let sequence = 0;
  let sending = null; // the batch of the change going out in pieces, until its last piece is answered
  let board = null;
  let longest = 0; // the most points in a stroke queued since the last take
  let limited = 0; // how many replies in a row were "rate" (see MAX_RATE_DELAY_MS)

  const busy = () => pending.size > 0 || inflight.size > 0;
  const changed = () => onChange(busy());

  // Sends `op` next; `rest` are the later pieces of the same change.
  function start(op, rest, batch) {
    const seq = ++sequence;
    for (const element of op.upsert) lastSent.set(element.id, seq);
    for (const removal of op.remove) lastSent.set(removal.id, seq);
    inflight.set(seq, { op, rest, batch });
    const piece = { seq, op };
    if (batch.group) piece.group = { id: batch.group.id, index: batch.started, total: batch.group.total };
    batch.started += 1;
    return piece;
  }

  // What's queued, as a batch of pieces (one, for a change that fits in a single message).
  function takeAll() {
    const [first, ...rest] = toOperations(pending);
    pending.clear();
    longest = 0;
    const group = rest.length > 0 ? { id: newId(), total: rest.length + 1 } : null;
    const batch = { group, started: 0, sent: [], failed: false };
    if (group) sending = batch;
    return { first, rest, batch };
  }

  // A piece of `batch` wasn't saved, so neither is the rest of it: other changes can go now.
  function fail(batch) {
    batch.failed = true;
    if (sending === batch) sending = null;
  }

  // Queues `op`'s changes again, except those a newer change superseded (`seq`
  // is the piece it was sent in; a piece never sent has none). Returns what was queued.
  function restore(op, seq) {
    const again = { upsert: [], remove: [] };
    const current = (id) => seq === undefined || lastSent.get(id) === seq;
    for (const element of op.upsert) {
      if (current(element.id) && !pending.has(element.id)) {
        pending.set(element.id, element);
        again.upsert.push(element);
      }
    }
    for (const removal of op.remove) {
      if (current(removal.id) && !pending.has(removal.id)) {
        pending.set(removal.id, { removal });
        again.remove.push(removal);
      }
    }
    return again;
  }

  // Pieces of a change sent together are held by the server until the last arrives, so after
  // a failure the whole change is queued again, answered pieces included, as a new group.
  function requeue({ op, rest, batch }, seq) {
    const again = restore(op, seq);
    for (const done of batch.sent) {
      const earlier = restore(done.op, done.seq);
      again.upsert.push(...earlier.upsert);
      again.remove.push(...earlier.remove);
    }
    for (const piece of rest) {
      const later = restore(piece);
      again.upsert.push(...later.upsert);
      again.remove.push(...later.remove);
    }
    return again;
  }

  function reset() {
    longest = 0;
    limited = 0;
    sending = null;
    pending.clear();
    lastSent.clear();
    inflight.clear();
    changed();
  }

  return {
    /** Whether anything is waiting to be sent, or sent and not confirmed (for "Saving…"). */
    busy,
    hasPending: () => pending.size > 0,

    /** How long to gather changes before the next send, in milliseconds. */
    flushDelay: () => FLUSH_INTERVAL_MS + Math.min(MAX_EXTRA_FLUSH_MS, longest * FLUSH_MS_PER_POINT),

    /** A change made here. */
    add(op) {
      for (const element of op.upsert ?? []) {
        pending.set(element.id, element);
        longest = Math.max(longest, element.points?.length ?? 0);
      }
      for (const removal of op.remove ?? []) pending.set(removal.id, { removal });
      changed();
    },

    /**
     * Moves what's queued into the next piece to send, `{ seq, op, group? }`, or returns null if
     * nothing is, or while a change in pieces is still going out (what's queued goes after it).
     */
    take() {
      if (pending.size === 0 || sending) return null;
      const { first, rest, batch } = takeAll();
      const piece = start(first, rest, batch);
      changed();
      return piece;
    },

    /**
     * Everything not sent yet, as pieces to send straight after one another without waiting for
     * replies: the rest of a change going out in pieces, then what's queued. For leaving a board,
     * when there's no waiting: the connection delivers them in order, before it says it's leaving.
     */
    drain() {
      const pieces = [];
      for (const entry of [...inflight.values()]) {
        for (const op of entry.rest) pieces.push(start(op, [], entry.batch));
        entry.rest = [];
      }
      if (pending.size > 0) {
        const { first, rest, batch } = takeAll();
        for (const op of [first, ...rest]) pieces.push(start(op, [], batch));
      }
      changed();
      return pieces;
    },

    /**
     * What to do with a piece's reply (`error` is a timeout):
     * - `{ kind: "ignore" }`: it was given up on already
     * - `{ kind: "ok", next?, cleaned?, dropped?, sent? }`: it's saved; `next` is the following piece of
     *   a big change to send; `cleaned` are elements as the server stored them where that differs from
     *   what we sent (`sent`: id -> the stamp each was sent with), `dropped` ids it refused because the
     *   board is full. Without a `next`, what was queued meanwhile can go (`take`)
     * - `{ kind: "retry", delay, again, slow? }`: queued again (`again`: what was queued), to send after `delay`
     *   (`slow`: the server has been refusing for a while: see SLOW_AFTER)
     * - `{ kind: "rejoin", again }`: queued again, to send once the board is joined again
     * - `{ kind: "resync", reason }`: it can't be saved, and neither can the rest of its group, which
     *   the server dropped. The screen should show the board as the server has it
     */
    settle(seq, error, response) {
      const entry = inflight.get(seq);
      if (!entry) return { kind: "ignore" };
      inflight.delete(seq);
      let result;
      const { batch } = entry;
      if (!error && response?.ok) {
        limited = 0;
        batch.sent.push({ op: entry.op, seq });
        result = { kind: "ok", cleaned: response.cleaned ?? [], dropped: response.dropped ?? [] };
        if (result.cleaned.length > 0) result.sent = sentStamps(batch);
        const [op, ...rest] = entry.rest;
        if (op) result.next = start(op, rest, batch);
        else if (sending === batch && batch.sent.length === batch.group.total) sending = null;
      } else if (error || Object.hasOwn(RETRY_DELAY_MS, response?.reason) || batch.failed) {
        // A piece sent after one of its group that wasn't saved is refused too (the server dropped
        // the group): it goes back in the queue with the rest, to be sent again.
        const why = error || batch.failed ? "timeout" : response.reason;
        fail(batch);
        let delay = RETRY_DELAY_MS[why];
        if (why === "rate") {
          delay = Math.min(MAX_RATE_DELAY_MS, delay * 2 ** limited) * (0.5 + random() / 2);
          limited += 1;
        }
        result = { kind: "retry", delay, again: requeue(entry, seq) };
        if (limited >= SLOW_AFTER) result.slow = true;
      } else if (response?.reason === "noSession") {
        fail(batch);
        result = { kind: "rejoin", again: requeue(entry, seq) };
      } else {
        fail(batch);
        result = { kind: "resync", reason: response?.reason ?? "invalid" };
      }
      changed();
      return result;
    },

    /** The connection dropped: what was sent but not confirmed goes back in the queue, to be sent again. */
    requeueSent() {
      for (const [seq, entry] of inflight) requeue(entry, seq);
      inflight.clear();
      sending = null;
      changed();
    },

    /** Everything not confirmed yet as one operation, to show on top of the board as the server has it. */
    unsent: () => toOperation(pending),

    /** Forgets everything (the screen is about to show the board as the server has it). */
    reset,

    /**
     * Call with the board that is open. When it isn't the one the queue holds
     * changes for, those are forgotten, so they can't be sent to another board.
     * Returns whether that happened.
     */
    switchTo(boardId) {
      if (board === boardId) return false;
      const switched = board !== null;
      board = boardId;
      if (switched) reset();
      return switched;
    },
  };
}
