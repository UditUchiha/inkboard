import type { Participant } from "@inkboard/shared/socket";
import { isOutdated, withChange } from "@inkboard/shared/suggestions";
import type { Suggestion } from "@inkboard/shared/suggestions";
import type { Element as BoardElement } from "@inkboard/shared/types";
import { useSyncExternalStore } from "react";
import { personColor } from "../../lib/format";
import type { HistoryEntry } from "./store";

// The suggestions open on a board (see shared/src/suggestions.ts and docs/suggest-mode.md): kept outside React state,
// like the pointers in cursors.ts, so the editor isn't rendered again for each one that arrives.

export type { Suggestion };

/** The store of a board's open suggestions, oldest first, for useSuggestions. */
export interface SuggestionStore {
  subscribe(listener: () => void): () => void;
  getSnapshot(): readonly Suggestion[];
  /** Replaces them all (joining a board). */
  load(list: readonly Suggestion[]): void;
  /** Adds these, or replaces the ones with the same ids. */
  upsert(list: readonly Suggestion[]): void;
  remove(ids: readonly string[]): void;
  clear(): void;
}

const NONE: readonly Suggestion[] = [];

export function createSuggestionStore(): SuggestionStore {
  let list = NONE;
  const listeners = new Set<() => void>();
  const set = (next: readonly Suggestion[]) => {
    list = next.length > 0 ? next : NONE;
    for (const listener of listeners) listener();
  };

  return {
    subscribe(listener) {
      listeners.add(listener);
      return () => listeners.delete(listener);
    },
    getSnapshot: () => list,
    load: (next) => set([...next]),
    upsert(next) {
      if (next.length === 0) return;
      const byId = new Map(list.map((suggestion) => [suggestion.id, suggestion]));
      for (const suggestion of next) byId.set(suggestion.id, suggestion);
      set([...byId.values()].sort((a, b) => a.createdAt - b.createdAt));
    },
    remove(ids) {
      const gone = new Set(ids);
      if (list.some((suggestion) => gone.has(suggestion.id)))
        set(list.filter((suggestion) => !gone.has(suggestion.id)));
    },
    clear() {
      if (list !== NONE) set(NONE);
    },
  };
}

/** A store with nothing in it, for boards nobody can suggest on (a guest's scratch board). */
export const noSuggestions = createSuggestionStore();

export function useSuggestions(store: SuggestionStore): readonly Suggestion[] {
  return useSyncExternalStore(store.subscribe, store.getSnapshot);
}

/** The element a suggestion is about: the one it adds, or the one on the board it changes or removes. */
export const elementIdOf = (suggestion: Suggestion) =>
  suggestion.kind === "add" ? suggestion.element.id : suggestion.target;

// Suggestions one person makes within this long of each other are shown, and decided on, as one.
export const GROUP_GAP_MS = 2 * 60 * 1000;

/** Suggestions shown as one: one person's, made close together. Its id is its first suggestion's. */
export type SuggestionGroup = { id: string; author: Participant; suggestions: Suggestion[] };

/** `list` (oldest first) as groups: each person's suggestions made within GROUP_GAP_MS of the one before. */
export function groupSuggestions(list: readonly Suggestion[]): SuggestionGroup[] {
  const groups: SuggestionGroup[] = [];
  const latest = new Map<string, { group: SuggestionGroup; at: number }>();
  for (const suggestion of list) {
    const key = `${suggestion.author.guest ? "guest" : "user"}:${suggestion.author.userId}`;
    const open = latest.get(key);
    if (open && suggestion.createdAt - open.at <= GROUP_GAP_MS) {
      open.group.suggestions.push(suggestion);
      open.at = suggestion.createdAt;
    } else {
      const group = { id: suggestion.id, author: suggestion.author, suggestions: [suggestion] };
      groups.push(group);
      latest.set(key, { group, at: suggestion.createdAt });
    }
  }
  return groups;
}

/**
 * The edit accepting `suggestions` makes to the board, as one step in history (see store.commit), from the board's
 * elements as `getElement` has them: additions put on the board under their own ids, changes' groups taken onto the
 * element as it is now, removals carried out. A suggestion about an element that has gone meanwhile (or an addition
 * already on the board) is left out of the edit, and listed in `skipped`. `accepted` are the ids of the rest.
 */
export function acceptance(
  suggestions: readonly Suggestion[],
  getElement: (id: string) => BoardElement | undefined,
): { entry: HistoryEntry; accepted: string[]; skipped: string[] } {
  const before = new Map<string, BoardElement>(); // elements as they were, for undoing
  const after = new Map<string, BoardElement | null>(); // and as accepting leaves them (null: removed)
  const added: string[] = [];
  const accepted: string[] = [];
  const skipped: string[] = [];
  // Several suggestions about one element (from different people) are each taken onto what the last one left.
  const now = (id: string) => (after.has(id) ? after.get(id) : getElement(id));

  for (const suggestion of suggestions) {
    const id = elementIdOf(suggestion);
    const current = now(id);
    if (suggestion.kind === "add" ? current !== undefined : !current) {
      skipped.push(suggestion.id);
      continue;
    }
    if (suggestion.kind === "add") {
      added.push(id);
      after.set(id, suggestion.element);
    } else {
      if (!before.has(id)) before.set(id, current!);
      after.set(id, suggestion.kind === "change" ? withChange(current!, suggestion) : null);
    }
    accepted.push(suggestion.id);
  }

  // (Changes and removals are only ever about elements on the board, never one being added here.)
  const shown = [...after.values()].filter((element): element is BoardElement => element !== null);
  const removed = [...after].filter(([, element]) => element === null).map(([id]) => id);
  return {
    entry: { undo: { upsert: [...before.values()], remove: added }, redo: { upsert: shown, remove: removed } },
    accepted,
    skipped,
  };
}

/** What the canvas draws for a suggestion (see renderScene). */
export type SuggestionMark = {
  id: string;
  kind: Suggestion["kind"];
  // What to draw: the element as suggested (an addition, or a change taken onto the element as it is), or the
  // element a removal is about.
  element: BoardElement;
  color: string;
  outdated: boolean;
  highlighted: boolean;
};

/** The marks for `suggestions` on the board as `getElement` has it. Ones about an element that has gone are left out. */
export function suggestionMarks(
  suggestions: readonly Suggestion[],
  getElement: (id: string) => BoardElement | undefined,
  highlighted: ReadonlySet<string> = new Set(),
): SuggestionMark[] {
  const marks: SuggestionMark[] = [];
  for (const suggestion of suggestions) {
    const color = personColor({ id: suggestion.author.userId, color: suggestion.author.color });
    const common = { id: suggestion.id, kind: suggestion.kind, color, highlighted: highlighted.has(suggestion.id) };
    if (suggestion.kind === "add") {
      marks.push({ ...common, element: suggestion.element, outdated: false });
      continue;
    }
    const current = getElement(suggestion.target);
    if (!current) continue;
    marks.push({
      ...common,
      element: suggestion.kind === "change" ? withChange(current, suggestion) : current,
      outdated: isOutdated(current, suggestion),
    });
  }
  return marks;
}

/** A few words on what a group suggests: "Adds 2, changes 1". */
export function summarize(suggestions: readonly Suggestion[]) {
  const count = (kind: Suggestion["kind"]) => suggestions.filter((suggestion) => suggestion.kind === kind).length;
  const parts = [
    [count("add"), "adds"],
    [count("change"), "changes"],
    [count("remove"), "removes"],
  ] as const;
  const said = parts.filter(([n]) => n > 0).map(([n, verb]) => `${verb} ${n}`);
  const text = said.join(", ");
  return text.charAt(0).toUpperCase() + text.slice(1);
}
