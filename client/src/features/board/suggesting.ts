import { groupsOf, groupStamps, stampOf, withStamps } from "@inkboard/shared/board-merge";
import type { SuggestionPutReply } from "@inkboard/shared/socket";
import { withChange } from "@inkboard/shared/suggestions";
import type { SuggestionDraft } from "@inkboard/shared/suggestions";
import type { Effect, Element as BoardElement, FieldGroup, Operation, Removal } from "@inkboard/shared/types";
import { createBoardStore, newVersionNonce } from "./store";
import type { BoardStore } from "./store";
import type { Suggestion, SuggestionStore } from "./suggestions";

// Suggesting (see docs/suggest-mode.md): someone with a "suggest" link draws, moves, recolors and deletes as on any
// board, on their own copy of it. Nothing they do reaches the board. Each change is sent as a suggestion instead:
// an element that isn't on the board is an addition, one that is a change of it, and one taken away a removal of it.
//
// Their copy is the editor's store, which keeps merging in everyone else's changes, so the board stays live under
// their suggestions. Beside it, this keeps the board as the server has it, without their suggestions: to tell what
// each of their changes is, and to show the board again when one of their suggestions goes (rejected, say).

// Changes made close together (a drag, a stroke as it's drawn) are sent as one, this long after the first.
export const SUGGEST_DELAY_MS = 120;
// After the server asks to slow down, or isn't ready yet, what's waiting is sent again after this long.
const RETRY_DELAY_MS = 1000;

/** What the editor needs to suggest: who it is, and how to send suggestions and hear back. */
export interface SuggesterOptions {
  // The editor's store: the suggester's copy of the board.
  store: BoardStore;
  suggestions: SuggestionStore;
  // Whether a suggestion is this person's own.
  isOwn: (suggestion: Suggestion) => boolean;
  // Sends drafts and the ids of own suggestions to take back; resolves with the server's answer to the drafts.
  send: (drafts: SuggestionDraft[], withdraw: string[]) => Promise<SuggestionPutReply>;
  // Told when the server left out some of what was sent (see SuggestionPutReply).
  onRefused?: (reply: { dropped: string[]; full?: "board" | "author" }) => void;
  delay?: number;
}

/** What a change made on the copy is, waiting to be sent or confirmed: the element as it is now, or its removal. */
type Unconfirmed = { element?: BoardElement; removal?: Removal; batch: number };

export type Suggester = ReturnType<typeof createSuggester>;

export function createSuggester({
  store,
  suggestions,
  isOwn,
  send,
  onRefused = () => {},
  delay = SUGGEST_DELAY_MS,
}: SuggesterOptions) {
  // The board as the server has it, without this person's suggestions.
  const board = createBoardStore();
  // Changes made on the copy that aren't in a suggestion the server has sent back yet, by element id. They're shown
  // over the board when it's shown again (see rebuild), so nothing being sent goes missing from this screen.
  const unconfirmed = new Map<string, Unconfirmed>();
  let batch = 0; // the batch now filling, which unconfirmed changes belong to until it's sent
  let timer: ReturnType<typeof setTimeout> | null = null;
  let stopped = false;

  // Stamped one past `current`, so the copy shows a suggestion over the board's version of the element.
  const past = (current: BoardElement) => ({
    version: stampOf(current).version + 1,
    versionNonce: newVersionNonce(),
  });

  // `next` (`current` with `groups` changed) stamped newer than `current` in those groups, and in any it adds.
  function newerIn(current: BoardElement, next: BoardElement, groups: readonly FieldGroup[]) {
    const stamps = groupStamps(current);
    const stamp = past(current);
    for (const group of groupsOf(next)) if (groups.includes(group) || !stamps[group]) stamps[group] = stamp;
    return withStamps(next, stamps);
  }

  // This person's suggestions as a change to lay over the board, then what they've changed since.
  function overlay(): Operation {
    const upsert: BoardElement[] = [];
    const remove: Removal[] = [];
    for (const suggestion of suggestions.getSnapshot()) {
      if (!isOwn(suggestion)) continue;
      if (suggestion.kind === "add") {
        upsert.push({ ...suggestion.element, version: 1, versionNonce: newVersionNonce() });
        continue;
      }
      const current = board.getElement(suggestion.target);
      if (!current) continue;
      if (suggestion.kind === "change")
        upsert.push(newerIn(current, withChange(current, suggestion), suggestion.groups));
      else remove.push({ id: suggestion.target, ...past(current) });
    }
    for (const change of unconfirmed.values()) {
      if (change.element) upsert.push(change.element);
      if (change.removal) remove.push(change.removal);
    }
    return { upsert, remove };
  }

  /** Shows the board as the server has it, with this person's suggestions on it. Their history is kept. */
  function rebuild() {
    store.rejoin(board.getElements(), overlay(), board.removedStamps());
  }

  function schedule(ms: number) {
    if (!stopped) timer ??= setTimeout(flush, ms);
  }

  async function flush() {
    timer = null;
    const sending = batch;
    batch += 1;
    const drafts: SuggestionDraft[] = [];
    const withdraw: string[] = [];
    for (const [id, change] of unconfirmed) {
      if (change.batch !== sending) continue;
      const onBoard = board.getElement(id) !== undefined;
      if (change.element) drafts.push({ kind: onBoard ? "change" : "add", element: change.element });
      else if (onBoard) drafts.push({ kind: "remove", target: id });
      else withdraw.push(`add:${id}`); // one of their own additions, taken away again
    }
    if (drafts.length === 0 && withdraw.length === 0) return;
    // Taken back here at once: the server only says so to everyone else.
    if (withdraw.length > 0) suggestions.remove(withdraw);

    const reply = await send(drafts, withdraw).catch(() => null);
    if (stopped) return;
    if (!reply?.ok && (reply === null || reply.reason === "rate" || reply.reason === "noSession")) {
      // Sent again with whatever is made meanwhile (and once joined again, for "noSession").
      for (const change of unconfirmed.values()) if (change.batch === sending) change.batch = batch;
      schedule(RETRY_DELAY_MS);
      return;
    }
    for (const [id, change] of unconfirmed) if (change.batch === sending) unconfirmed.delete(id);
    if (!reply.ok) {
      // Not allowed (any more), or not understood: show the board as it is, with what was kept of theirs.
      rebuild();
      return;
    }
    suggestions.upsert(reply.suggestions);
    if (reply.withdrawn) suggestions.remove(reply.withdrawn);
    if (reply.dropped?.length) {
      rebuild();
      onRefused({ dropped: reply.dropped, ...(reply.full ? { full: reply.full } : {}) });
    }
  }

  return {
    /** The board as the server has it, without this person's suggestions. */
    board,

    /** Joined the board (again): the store was loaded with `elements`, which this shows their suggestions on. */
    joined(elements: BoardElement[], removed: unknown) {
      board.load(elements, removed);
      store.applyRemote(overlay());
      if (unconfirmed.size > 0) schedule(0);
    },

    /** Someone else's change to the board (the store has taken it in too). */
    remote(op: Operation) {
      board.applyRemote(op);
    },

    /** Someone restored an earlier version: the board is replaced, and what was being sent with it. */
    reset(elements: BoardElement[], removed: unknown) {
      unconfirmed.clear();
      board.load(elements, removed);
      rebuild();
    },

    rebuild,

    /** A change made on the copy, as the store broadcasts it: sent as suggestions shortly. */
    take(effect: Effect) {
      for (const element of effect.upsert) unconfirmed.set(element.id, { element, batch });
      for (const removal of effect.remove) unconfirmed.set(removal.id, { removal, batch });
      schedule(delay);
    },

    /** Sends what's waiting now, rather than after the delay. */
    flush,

    /** Forgets what was waiting to be sent (another board was opened in the same screen). */
    forget() {
      unconfirmed.clear();
      clearTimeout(timer ?? undefined);
      timer = null;
    },

    /** Starts sending (again, after stop: the screen it's on was put back, as React may do). */
    start() {
      stopped = false;
    },

    /** Stops: nothing more is sent, and answers still on their way are let be. */
    stop() {
      stopped = true;
      unconfirmed.clear();
      clearTimeout(timer ?? undefined);
      timer = null;
    },
  };
}
