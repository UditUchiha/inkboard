// Changes proposed by someone who may only suggest, which a member accepts or rejects (docs/suggest-mode.md). Each is
// about one element: add (not on the board), change (only the groups the author changed are taken on accepting, so
// another group edited meanwhile stays) or remove. A change or removal remembers the stamps its groups had (`base`), to
// tell when the element was edited since (see isOutdated).

import { compareStamps, copyGroup, FIELD_GROUPS, groupStamps } from "./board-merge.ts";
import type { Participant } from "./socket.ts";
import type { Element, Fields, FieldGroup, GroupStamps, Stamp } from "./types.ts";

export type SuggestionKind = "add" | "change" | "remove";

interface SuggestionCommon {
  id: string;
  author: Participant;
  createdAt: number;
  updatedAt: number;
}

export type AddSuggestion = SuggestionCommon & { kind: "add"; element: Element };
export type ChangeSuggestion = SuggestionCommon & {
  kind: "change";
  target: string;
  element: Element;
  groups: FieldGroup[];
  base: GroupStamps;
};
export type RemoveSuggestion = SuggestionCommon & { kind: "remove"; target: string; base: GroupStamps };

export type Suggestion = AddSuggestion | ChangeSuggestion | RemoveSuggestion;

export type SuggestionDraft =
  { kind: "add"; element: Element } | { kind: "change"; element: Element } | { kind: "remove"; target: string };

// An addition is known by its element's id; a change or removal by author and element, so each person has at most one
// per element (a further edit replaces it). The prefixes keep the two apart, as element ids can be any short string.
export function suggestionId(kind: SuggestionKind, authorId: string, elementId: string) {
  return kind === "add" ? `add:${elementId}` : `on:${authorId}:${elementId}`;
}

const same = (a: unknown, b: unknown) => a === b || JSON.stringify(a) === JSON.stringify(b);

export function changedGroups(current: Element, proposed: Element): FieldGroup[] {
  const before: Fields = current;
  const after: Fields = proposed;
  return (Object.keys(FIELD_GROUPS) as FieldGroup[]).filter((group) =>
    FIELD_GROUPS[group].some((field) => !same(before[field], after[field])),
  );
}

export function stampsOf(element: Element, groups?: readonly FieldGroup[]): GroupStamps {
  const all = groupStamps(element);
  if (!groups) return all;
  const picked: GroupStamps = {};
  for (const group of groups) if (all[group]) picked[group] = all[group];
  return picked;
}

// since it was made, in the groups the suggestion is about (all, for a removal); accepting it then replaces that edit
export function isOutdated(current: Element, suggestion: ChangeSuggestion | RemoveSuggestion) {
  const now = groupStamps(current);
  return (Object.entries(suggestion.base) as [FieldGroup, Stamp][]).some(([group, stamp]) => {
    const stampNow = now[group];
    return !stampNow || compareStamps(stampNow, stamp) !== 0;
  });
}

export function withChange(current: Element, change: Pick<ChangeSuggestion, "element" | "groups">): Element {
  const next: Fields = { ...current };
  for (const group of change.groups) copyGroup(next, change.element, group);
  return next as Element;
}
