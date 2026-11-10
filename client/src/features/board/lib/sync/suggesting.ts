import { groupsOf, groupStamps, stampOf, withStamps } from "@inkboard/shared/board-merge";
import type { SuggestionPutReply } from "@inkboard/shared/socket";
import { withChange } from "@inkboard/shared/suggestions";
import type { SuggestionDraft } from "@inkboard/shared/suggestions";
import type { Effect, Element as BoardElement, FieldGroup, Operation, Removal } from "@inkboard/shared/types";
import { createBoardStore, newVersionNonce } from "./store";
import type { BoardStore } from "./store";
import type { Suggestion, SuggestionStore } from "./suggestions";

// Suggest mode (docs/suggest-mode.md): edits go to the person's own copy, the editor's store, which keeps merging
// others' changes; each change is sent as a suggestion, never to the board. `board` keeps the board as the server has
// it, to tell what each change is and to show it again when a suggestion goes.

// Changes made close together (a drag, a stroke as it's drawn) are sent as one, this long after the first.
export const SUGGEST_DELAY_MS = 120;
// After the server asks to slow down, or isn't ready yet, what's waiting is sent again after this long.
const RETRY_DELAY_MS = 1000;

export interface SuggesterOptions {
  store: BoardStore;
  suggestions: SuggestionStore;
  isOwn: (suggestion: Suggestion) => boolean;
  send: (drafts: SuggestionDraft[], withdraw: string[]) => Promise<SuggestionPutReply>;
  onRefused?: (reply: { dropped: string[]; full?: "board" | "author" }) => void;
  delay?: number;
}

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
  const board = createBoardStore();
  // Changes not yet in a suggestion the server sent back; shown over the board on rebuild so nothing being sent
  // vanishes.
  const unconfirmed = new Map<string, Unconfirmed>();
  let batch = 0; // the batch now filling, which unconfirmed changes belong to until it's sent
  let timer: ReturnType<typeof setTimeout> | null = null;
  let stopped = false;

  // Stamped one past `current`, so the copy shows a suggestion over the board's version of the element.
  const past = (current: BoardElement) => ({
    version: stampOf(current).version + 1,
    versionNonce: newVersionNonce(),
  });

  function newerIn(current: BoardElement, next: BoardElement, groups: readonly FieldGroup[]) {
    const stamps = groupStamps(current);
    const stamp = past(current);
    for (const group of groupsOf(next)) if (groups.includes(group) || !stamps[group]) stamps[group] = stamp;
    return withStamps(next, stamps);
  }

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
    board,

    joined(elements: BoardElement[], removed: unknown) {
      board.load(elements, removed);
      store.applyRemote(overlay());
      if (unconfirmed.size > 0) schedule(0);
    },

    remote(op: Operation) {
      board.applyRemote(op);
    },

    reset(elements: BoardElement[], removed: unknown) {
      unconfirmed.clear();
      board.load(elements, removed);
      rebuild();
    },

    rebuild,

    take(effect: Effect) {
      for (const element of effect.upsert) unconfirmed.set(element.id, { element, batch });
      for (const removal of effect.remove) unconfirmed.set(removal.id, { removal, batch });
      schedule(delay);
    },

    flush,

    forget() {
      unconfirmed.clear();
      clearTimeout(timer ?? undefined);
      timer = null;
    },

    start() {
      stopped = false;
    },

    stop() {
      stopped = true;
      unconfirmed.clear();
      clearTimeout(timer ?? undefined);
      timer = null;
    },
  };
}
