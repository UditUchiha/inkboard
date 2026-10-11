// Suggestions: changes proposed on a board by someone who may only suggest (a "suggest" link), which a
// member accepts or rejects (see docs/suggest-mode.md). The browser and the server both read them with
// these rules, so what one shows as changed is what the other takes in.
//
// Each suggestion is about one element:
//   add     a new element, not on the board
//   change  an element on the board as the author would have it; only the property groups they changed
//           (see FIELD_GROUPS in board-merge.ts) are taken when it's accepted, so an edit someone else
//           made meanwhile to another group stays
//   remove  an element on the board the author would take away
// A change and a removal remember the stamps the element's groups had when they were made (`base`), so a
// suggestion about an element edited since can be told apart (see isOutdated).

import { compareStamps, copyGroup, FIELD_GROUPS, groupStamps } from "./board-merge.ts";
import type { Participant } from "./socket.ts";
import type { Element, Fields, FieldGroup, GroupStamps, Stamp } from "./types.ts";

export type SuggestionKind = "add" | "change" | "remove";

/** What every suggestion has: its id (see suggestionId), who made it, and when (milliseconds since 1970). */
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

/**
 * What a suggester sends: a new element, an element on the board as they would have it, or the id of one
 * they would remove. The server works out the rest (the groups changed, the stamps, the author).
 */
export type SuggestionDraft =
  { kind: "add"; element: Element } | { kind: "change"; element: Element } | { kind: "remove"; target: string };

/**
 * A suggestion's id. An addition is known by its element's id; a change or a removal by its author and the
 * element it's about, so each person has at most one about each element (a further edit replaces it, and
 * removing an element they had suggested changes to turns that into a removal). The prefixes keep the two
 * apart, as an element's id can be any short string.
 */
export function suggestionId(kind: SuggestionKind, authorId: string, elementId: string) {
  return kind === "add" ? `add:${elementId}` : `on:${authorId}:${elementId}`;
}

// Field values compared as JSON: they are numbers, strings, null, or arrays of those (a stroke's points).
const same = (a: unknown, b: unknown) => a === b || JSON.stringify(a) === JSON.stringify(b);

/** The property groups in which `proposed` differs from `current`, the same element on the board. */
export function changedGroups(current: Element, proposed: Element): FieldGroup[] {
  const before: Fields = current;
  const after: Fields = proposed;
  // Object.keys can only say "strings"; these are the keys of FIELD_GROUPS, so they are field groups.
  return (Object.keys(FIELD_GROUPS) as FieldGroup[]).filter((group) =>
    FIELD_GROUPS[group].some((field) => !same(before[field], after[field])),
  );
}

/** The stamps `element` has for `groups`, to remember with a suggestion about it (see isOutdated). */
export function stampsOf(element: Element, groups?: readonly FieldGroup[]): GroupStamps {
  const all = groupStamps(element);
  if (!groups) return all;
  const picked: GroupStamps = {};
  for (const group of groups) if (all[group]) picked[group] = all[group];
  return picked;
}

/**
 * Whether the element a change or removal is about has been edited, in the groups the suggestion is
 * about (all of them, for a removal), since it was made. Accepting it then replaces that edit.
 */
export function isOutdated(current: Element, suggestion: ChangeSuggestion | RemoveSuggestion) {
  const now = groupStamps(current);
  // Object.entries can only say "strings"; these are the keys of `base`, so they are field groups.
  return (Object.entries(suggestion.base) as [FieldGroup, Stamp][]).some(([group, stamp]) => {
    const stampNow = now[group];
    return !stampNow || compareStamps(stampNow, stamp) !== 0;
  });
}

/** `current` with a change suggestion's groups taken from it: what accepting the change makes the element. */
export function withChange(current: Element, change: Pick<ChangeSuggestion, "element" | "groups">): Element {
  const next: Fields = { ...current };
  for (const group of change.groups) copyGroup(next, change.element, group);
  // Each group is copied whole from an element of the same id, so what comes out is an element.
  return next as Element;
}
