import type { Participant } from "@inkboard/shared/socket";
import { isOutdated, withChange } from "@inkboard/shared/suggestions";
import type { Suggestion } from "@inkboard/shared/suggestions";
import type { Element as BoardElement } from "@inkboard/shared/types";
import { useSyncExternalStore } from "react";
import { personColor } from "../../../../lib/format";
import type { HistoryEntry } from "./store";

// Kept outside React state, like cursors.ts, so the editor isn't rendered again for each arriving suggestion.

export type { Suggestion };

export interface SuggestionStore {
  subscribe(listener: () => void): () => void;
  getSnapshot(): readonly Suggestion[];
  load(list: readonly Suggestion[]): void;
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

export const noSuggestions = createSuggestionStore();

export function useSuggestions(store: SuggestionStore): readonly Suggestion[] {
  return useSyncExternalStore(store.subscribe, store.getSnapshot);
}

export const elementIdOf = (suggestion: Suggestion) =>
  suggestion.kind === "add" ? suggestion.element.id : suggestion.target;

// Suggestions one person makes within this long of each other are shown, and decided on, as one.
export const GROUP_GAP_MS = 2 * 60 * 1000;

export type SuggestionGroup = { id: string; author: Participant; suggestions: Suggestion[] };

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

// Skips suggestions about elements that have gone (or additions already on the board), listing them in `skipped`.
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

export type SuggestionMark = {
  id: string;
  kind: Suggestion["kind"];
  element: BoardElement;
  color: string;
  outdated: boolean;
  highlighted: boolean;
  // Drawn faded as well as outlined when the element isn't among what the screen shows.
  ghost: boolean;
};

// `underneath` is the board without the suggester's own suggestions, where an element they'd remove still is.
export type OwnSuggestions = {
  isOwn: (suggestion: Suggestion) => boolean;
  underneath: (id: string) => BoardElement | undefined;
};

export function suggestionMarks(
  suggestions: readonly Suggestion[],
  getElement: (id: string) => BoardElement | undefined,
  highlighted: ReadonlySet<string> = new Set(),
  own?: OwnSuggestions,
): SuggestionMark[] {
  const marks: SuggestionMark[] = [];
  for (const suggestion of suggestions) {
    const color = personColor({ id: suggestion.author.userId, color: suggestion.author.color });
    const common = { id: suggestion.id, kind: suggestion.kind, color, highlighted: highlighted.has(suggestion.id) };
    if (own?.isOwn(suggestion)) {
      const id = elementIdOf(suggestion);
      const shown = suggestion.kind === "remove" ? own.underneath(id) : getElement(id);
      if (shown) marks.push({ ...common, element: shown, outdated: false, ghost: suggestion.kind === "remove" });
      continue;
    }
    if (suggestion.kind === "add") {
      marks.push({ ...common, element: suggestion.element, outdated: false, ghost: true });
      continue;
    }
    const current = getElement(suggestion.target);
    if (!current) continue;
    marks.push({
      ...common,
      element: suggestion.kind === "change" ? withChange(current, suggestion) : current,
      outdated: isOutdated(current, suggestion),
      ghost: suggestion.kind === "change",
    });
  }
  return marks;
}

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
