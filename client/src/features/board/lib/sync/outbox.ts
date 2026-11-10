import { stampOf } from "@inkboard/shared/board-merge";
import { spliceOf, TEXT_FIELDS, textBefore, withoutBase } from "@inkboard/shared/text-merge";
import type {
  Element as BoardElement,
  Effect,
  FieldGroup,
  Fields,
  Splice,
  Stamp,
  TextBases,
  TextField,
} from "@inkboard/shared/types";
import { newId } from "../elements/elements";
import { toOperation, toOperations } from "./store";
import type { PendingChange, Typing } from "./store";

export type { PendingChange };

// Changes made here that the server hasn't confirmed (see useBoardSync); no sockets or React, so replies can be tested alone.
// A big change goes out in pieces sharing a `group`, so the server takes them in together or not at all.
// Nothing else is sent meanwhile: the server holds one group per connection, so a removal sent mid-upload would be applied first, then undone.

// A stroke is sent whole each time, so a longer flush keeps its traffic flat instead of growing with every point.
const FLUSH_INTERVAL_MS = 40;
const FLUSH_MS_PER_POINT = 0.4;
const MAX_EXTRA_FLUSH_MS = 400;

// Retry delay by reason ("expired": the server stopped waiting for the rest of a big change).
export const RETRY_DELAY_MS: Record<string, number> = { timeout: 400, rate: 1000, expired: 0 };

// "rate" refusals back off exponentially up to MAX_RATE_DELAY_MS, with jitter so limited connections don't return together;
// after SLOW_AFTER in a row the retry sets `slow`, so the screen can say saving takes a while.
const MAX_RATE_DELAY_MS = 30_000;
const SLOW_AFTER = 3;

export type Piece = { seq: number; op: Effect; group?: { id: string; index: number; total: number } };

export type AckReply = {
  ok?: boolean;
  reason?: string;
  cleaned?: BoardElement[];
  // Ids of new elements it refused because the board is full (or, with `outside`, outside a student's frame).
  dropped?: string[];
  // In classroom mode: elements a student removed outside their frame, as the board still has them.
  restored?: BoardElement[];
  outside?: boolean;
};

export type SettleResult =
  | { kind: "ignore" }
  | {
      kind: "ok";
      cleaned: BoardElement[];
      dropped: string[];
      restored: BoardElement[];
      outside: boolean;
      sent?: Map<string, Stamp>;
      typed?: Typing;
      next?: Piece;
    }
  | { kind: "retry"; delay: number; again: Effect; slow?: boolean }
  | { kind: "rejoin"; again: Effect }
  | { kind: "resync"; reason: string };

export type OutboxOptions = { onChange?: (busy: boolean) => void; random?: () => number };

export type Outbox = ReturnType<typeof createOutbox>;

type Batch = {
  group: { id: string; total: number } | null;
  started: number;
  sent: { op: Effect; seq: number }[];
  failed: boolean;
};

type Inflight = { op: Effect; rest: Effect[]; batch: Batch };

// A text typed over a queued `earlier` was typed against what the server still has (see text-merge.ts).
function sinceUnsent(element: BoardElement, earlier: PendingChange | undefined): BoardElement {
  if (!earlier || earlier.removal || !earlier.base) return element;
  const base: TextBases = { ...element.base };
  for (const [field, splice] of Object.entries(earlier.base) as [TextField, Splice][]) {
    const was = (earlier as Fields)[field];
    const now = (element as Fields)[field];
    if (typeof was === "string" && typeof now === "string") base[field] = spliceOf(textBefore(was, splice), now);
  }
  return { ...element, base };
}

// Resent without knowing whether the server took it: sent without typing bases so it can't be merged twice.
const blind = (element: BoardElement): BoardElement => (element.base ? withoutBase(element) : element);

function typedIn(elements: readonly BoardElement[]): Map<string, Set<FieldGroup>> {
  const typed = new Map<string, Set<FieldGroup>>();
  for (const element of elements) {
    if (!element.base) continue;
    const groups = typed.get(element.id) ?? new Set<FieldGroup>();
    for (const field of Object.keys(element.base) as TextField[]) groups.add(TEXT_FIELDS[field].group);
    typed.set(element.id, groups);
  }
  return typed;
}

function sentStamps(batch: Batch): Map<string, Stamp> {
  const stamps = new Map<string, Stamp>();
  for (const { op } of batch.sent) for (const element of op.upsert) stamps.set(element.id, stampOf(element));
  return stamps;
}

export function createOutbox({ onChange = () => {}, random = Math.random }: OutboxOptions = {}) {
  const pending = new Map<string, PendingChange>(); // id -> element | { removal }, not sent yet
  const lastSent = new Map<string, number>(); // id -> sequence number of the last piece that included it
  const inflight = new Map<number, Inflight>(); // sequence number -> { op, rest, batch }: sent, no reply yet
  let sequence = 0;
  let sending: Batch | null = null; // the batch of the change going out in pieces, until its last piece is answered
  let board: string | null = null;
  let longest = 0; // the most points in a stroke queued since the last take
  let limited = 0; // how many replies in a row were "rate" (see MAX_RATE_DELAY_MS)

  const busy = () => pending.size > 0 || inflight.size > 0;
  const changed = () => onChange(busy());

  function start(op: Effect, rest: Effect[], batch: Batch): Piece {
    const seq = ++sequence;
    for (const element of op.upsert) lastSent.set(element.id, seq);
    for (const removal of op.remove) lastSent.set(removal.id, seq);
    inflight.set(seq, { op, rest, batch });
    const piece: Piece = { seq, op };
    if (batch.group) piece.group = { id: batch.group.id, index: batch.started, total: batch.group.total };
    batch.started += 1;
    return piece;
  }

  function takeAll() {
    const [first, ...rest] = toOperations(pending);
    pending.clear();
    longest = 0;
    const group = rest.length > 0 ? { id: newId(), total: rest.length + 1 } : null;
    const batch: Batch = { group, started: 0, sent: [], failed: false };
    if (group) sending = batch;
    return { first, rest, batch };
  }

  function fail(batch: Batch) {
    batch.failed = true;
    if (sending === batch) sending = null;
  }

  // Queues `op` again except what a newer change superseded; when the server certainly hasn't taken it (`taken` false),
  // changes queued meanwhile are rebased on it (see sinceUnsent).
  function restore(op: Effect, seq: number | undefined, taken: boolean): Effect {
    const again: Effect = { upsert: [], remove: [] };
    const current = (id: string) => seq === undefined || lastSent.get(id) === seq;
    for (const element of op.upsert) {
      if (!current(element.id)) continue;
      const newer = pending.get(element.id);
      if (!newer) {
        const queued = taken ? blind(element) : element;
        pending.set(element.id, queued);
        again.upsert.push(queued);
      } else if (!newer.removal && !taken) pending.set(element.id, sinceUnsent(newer, element));
    }
    for (const removal of op.remove) {
      if (current(removal.id) && !pending.has(removal.id)) {
        pending.set(removal.id, { removal });
        again.remove.push(removal);
      }
    }
    return again;
  }

  // The server holds a change's pieces until the last arrives, so after a failure the whole change is queued again as a new group.
  function requeue({ op, rest, batch }: Inflight, seq: number | undefined, taken: boolean): Effect {
    const again = restore(op, seq, taken);
    for (const done of batch.sent) {
      // Held by the server with the piece that failed, and dropped with it.
      const earlier = restore(done.op, done.seq, taken);
      again.upsert.push(...earlier.upsert);
      again.remove.push(...earlier.remove);
    }
    for (const piece of rest) {
      const later = restore(piece, undefined, false);
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
    busy,
    hasPending: () => pending.size > 0,

    flushDelay: () => FLUSH_INTERVAL_MS + Math.min(MAX_EXTRA_FLUSH_MS, longest * FLUSH_MS_PER_POINT),

    add(op: Partial<Effect>) {
      for (const element of op.upsert ?? []) {
        pending.set(element.id, sinceUnsent(element, pending.get(element.id)));
        longest = Math.max(longest, (element as { points?: unknown[] }).points?.length ?? 0);
      }
      for (const removal of op.remove ?? []) pending.set(removal.id, { removal });
      changed();
    },

    take() {
      if (pending.size === 0 || sending) return null;
      const { first, rest, batch } = takeAll();
      const piece = start(first, rest, batch);
      changed();
      return piece;
    },

    // For leaving a board: pieces go back to back, relying on in-order delivery before the leave message.
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

    // Results: ignore, ok (maybe a `next` piece), retry after `delay`, rejoin, or resync (can't be saved: show the server's board).
    settle(seq: number, error: Error | null, response: AckReply | undefined): SettleResult {
      const entry = inflight.get(seq);
      if (!entry) return { kind: "ignore" };
      inflight.delete(seq);
      let result: SettleResult;
      const { batch } = entry;
      if (!error && response?.ok) {
        limited = 0;
        batch.sent.push({ op: entry.op, seq });
        result = {
          kind: "ok",
          cleaned: response.cleaned ?? [],
          dropped: response.dropped ?? [],
          restored: response.restored ?? [],
          outside: response.outside === true,
        };
        if (result.cleaned.length > 0) {
          result.sent = sentStamps(batch);
          result.typed = typedIn(batch.sent.flatMap(({ op }) => op.upsert));
        }
        const [op, ...rest] = entry.rest;
        if (op) result.next = start(op, rest, batch);
        else if (sending === batch && batch.sent.length === batch.group!.total) sending = null;
      } else if (error || Object.hasOwn(RETRY_DELAY_MS, response?.reason as string) || batch.failed) {
        // A piece after a failed one in its group is refused too (the server dropped the group), so it is queued again.
        const why = error || batch.failed ? "timeout" : (response!.reason as string);
        // No reply: it may have been taken in (unless the server had dropped its group already).
        const taken = Boolean(error) && !batch.failed;
        fail(batch);
        let delay = RETRY_DELAY_MS[why];
        if (why === "rate") {
          delay = Math.min(MAX_RATE_DELAY_MS, delay * 2 ** limited) * (0.5 + random() / 2);
          limited += 1;
        }
        result = { kind: "retry", delay, again: requeue(entry, seq, taken) };
        if (limited >= SLOW_AFTER) result.slow = true;
      } else if (response?.reason === "noSession") {
        fail(batch);
        result = { kind: "rejoin", again: requeue(entry, seq, false) };
      } else {
        fail(batch);
        result = { kind: "resync", reason: response?.reason ?? "invalid" };
      }
      changed();
      return result;
    },

    requeueSent() {
      for (const [seq, entry] of inflight) requeue(entry, seq, true);
      inflight.clear();
      sending = null;
      changed();
    },

    // Typed-here text the server hasn't answered: others' changes don't replace it here; the server's answer merges them (store.applyRemote).
    typing() {
      const elements: BoardElement[] = [];
      for (const { op, rest } of inflight.values()) for (const piece of [op, ...rest]) elements.push(...piece.upsert);
      for (const [, change] of pending) if (!change.removal) elements.push(change);
      return typedIn(elements);
    },

    unsent: () => toOperation(pending),

    reset,

    // Forgets queued changes when another board opens, so they can't be sent to it.
    switchTo(boardId: string) {
      if (board === boardId) return false;
      const switched = board !== null;
      board = boardId;
      if (switched) reset();
      return switched;
    },
  };
}
