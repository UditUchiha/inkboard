import { cleanElement } from "@inkboard/shared/element-rules";
import {
  MAX_SUGGESTION_BYTES,
  MAX_SUGGESTIONS_PER_AUTHOR,
  MAX_SUGGESTIONS_PER_BOARD,
  SUGGESTION_MAX_AGE_MS,
} from "@inkboard/shared/limits";
import type { Participant } from "@inkboard/shared/socket";
import { changedGroups, stampsOf, suggestionId } from "@inkboard/shared/suggestions";
import type { Suggestion, SuggestionKind } from "@inkboard/shared/suggestions";
import type { Element, FieldGroup, GroupStamps } from "@inkboard/shared/types";
import mongoose from "mongoose";
import { MAX_ELEMENT_BYTES } from "./operations.ts";

// The suggestions open on a board (see shared/src/suggestions.ts and docs/suggest-mode.md). They are kept
// with the board while it's open, like its elements, and saved with it (see sessions.ts). Nothing here
// changes the board: a member accepts a suggestion by making the change themselves.

/** A board's open suggestions, by id, with the bytes each takes and the total. */
export interface SuggestionState {
  byId: Map<string, Suggestion>;
  sizes: Map<string, number>;
  bytes: number;
}

/** What suggestions are about: the board's elements by id. */
type Board = { index: Map<string, Element> };

const KINDS = new Set<SuggestionKind>(["add", "change", "remove"]);

const sizeOf = (suggestion: Suggestion) => mongoose.mongo.BSON.calculateObjectSize({ suggestion });

/** Whether two people are the same author: the same account, or the same guest. */
const sameAuthor = (a: Participant, b: Participant) => a.userId === b.userId && a.guest === b.guest;

export function emptySuggestions(): SuggestionState {
  return { byId: new Map(), sizes: new Map(), bytes: 0 };
}

function keep(state: SuggestionState, suggestion: Suggestion, size = sizeOf(suggestion)) {
  state.bytes += size - (state.sizes.get(suggestion.id) ?? 0);
  state.byId.set(suggestion.id, suggestion);
  state.sizes.set(suggestion.id, size);
}

function drop(state: SuggestionState, id: string) {
  if (!state.byId.delete(id)) return false;
  state.bytes -= state.sizes.get(id) ?? 0;
  state.sizes.delete(id);
  return true;
}

/** Suggestions as saved with a board, as a session keeps them. Ones that aren't readable are left out. */
export function readSuggestions(saved: unknown): SuggestionState {
  const state = emptySuggestions();
  // Written by this server; each entry is still looked at before it's used.
  for (const entry of (Array.isArray(saved) ? saved : []) as Partial<Suggestion>[]) {
    if (
      typeof entry?.id === "string" &&
      KINDS.has(entry.kind as SuggestionKind) &&
      typeof entry.author?.userId === "string" &&
      Number.isFinite(entry.createdAt) &&
      Number.isFinite(entry.updatedAt)
    ) {
      keep(state, entry as Suggestion);
    }
  }
  return state;
}

/** The open suggestions, oldest first. */
export const suggestionList = (state: SuggestionState) => [...state.byId.values()];

// An element as a suggestion keeps it: cleaned as the board would store it, without the stamps, which belong to
// the board's merge (a suggestion isn't in it until a member makes the change).
function suggestedElement(raw: unknown) {
  const clean = cleanElement(raw);
  if (!clean) return null;
  const { version: _version, versionNonce: _nonce, stamps: _stamps, ...element } = clean;
  return element as Element;
}

/** What a suggestion has besides its id, kind, author and times: whichever of these its kind has. */
type SuggestionParts = { element?: Element; target?: string; groups?: FieldGroup[]; base?: GroupStamps };

/** What putSuggestions did: what it kept, what it took back, and the element ids of drafts it left out. */
export interface PutResult {
  stored: Suggestion[];
  withdrawn: string[];
  dropped: string[];
  full?: "board" | "author";
}

/** A draft as it arrives: what each part is isn't known yet. */
type Draft = { kind?: unknown; element?: unknown; target?: unknown } | null | undefined;

/**
 * What `draft` proposes, from `author` on the board `board`: a suggestion; the id of the author's suggestion it
 * takes back (it makes the element just as it is on the board); or null, for a draft that can't be taken in.
 */
function readDraft(
  draft: Draft,
  board: Board,
  author: Participant,
  now: number,
): Suggestion | { withdraw: string } | null {
  const make = (kind: SuggestionKind, elementId: string, parts: SuggestionParts) =>
    // Each call below gives the parts its kind has, which TypeScript can't put together as one case of the union.
    ({
      id: suggestionId(kind, author.userId, elementId),
      kind,
      ...parts,
      author,
      createdAt: now,
      updatedAt: now,
    }) as Suggestion;

  if (draft?.kind === "remove") {
    const current = typeof draft.target === "string" ? board.index.get(draft.target) : undefined;
    return current ? make("remove", current.id, { target: current.id, base: stampsOf(current) }) : null;
  }
  const element = suggestedElement(draft?.element);
  if (!element) return null;
  if (draft?.kind === "add") {
    // A new element, so not one on the board, and not a picture: uploads take the owner's space.
    if (element.type === "image" || board.index.has(element.id)) return null;
    const { index: _index, ...fields } = element; // it goes on top when it's accepted
    return make("add", element.id, { element: fields as Element });
  }
  const current = draft?.kind === "change" ? board.index.get(element.id) : undefined;
  if (!current) return null;
  // Where it sits in the stack is the board's unless the author moved it up or down.
  const proposed = element.index ? element : { ...element, index: current.index };
  const groups = changedGroups(current, proposed);
  if (groups.length === 0) return { withdraw: suggestionId("change", author.userId, current.id) };
  return make("change", current.id, { target: current.id, element: proposed, groups, base: stampsOf(current, groups) });
}

/**
 * The limit keeping the suggestion `id`, of `size` bytes, would go past, or null if it fits. `authorFull` says
 * whether its author already has as many open as one person may (only a new one counts toward that).
 */
function limitMet(state: SuggestionState, id: string, size: number, authorFull: boolean): PutResult["full"] | null {
  const isNew = !state.byId.has(id);
  if (isNew && state.byId.size >= MAX_SUGGESTIONS_PER_BOARD) return "board";
  if (isNew && authorFull) return "author";
  if (state.bytes - (state.sizes.get(id) ?? 0) + size > MAX_SUGGESTION_BYTES) return "board";
  return null;
}

/**
 * Takes in what `author` suggests (drafts, as sent: see SuggestionDraft), on the board `board`. A draft that
 * makes an element just as it is on the board takes back the author's suggestion about it. Each person may
 * only replace their own suggestions.
 */
export function putSuggestions(
  state: SuggestionState,
  board: Board,
  author: Participant,
  drafts: unknown[],
  now = Date.now(),
): PutResult {
  const result: PutResult = { stored: [], withdrawn: [], dropped: [] };
  let own = 0;
  for (const suggestion of state.byId.values()) if (sameAuthor(suggestion.author, author)) own += 1;

  for (const draft of drafts as Draft[]) {
    const next = readDraft(draft, board, author, now);
    if (next && "withdraw" in next) {
      const existing = state.byId.get(next.withdraw);
      if (existing && sameAuthor(existing.author, author) && drop(state, next.withdraw)) {
        result.withdrawn.push(next.withdraw);
      }
      continue;
    }
    const existing = next ? state.byId.get(next.id) : undefined;
    // Someone else's suggestion can't be replaced (an addition is known by an element id its author chose).
    const taken = existing !== undefined && !sameAuthor(existing.author, author);
    const size = next && !taken ? sizeOf(next) : 0;
    const full = next && !taken ? limitMet(state, next.id, size, !existing && own >= MAX_SUGGESTIONS_PER_AUTHOR) : null;
    if (!next || taken || full || size > MAX_ELEMENT_BYTES) {
      if (full) result.full = full;
      const claimed = draft?.kind === "remove" ? draft.target : (draft?.element as { id?: unknown } | null)?.id;
      if (typeof claimed === "string") result.dropped.push(claimed);
      continue;
    }
    if (existing) next.createdAt = existing.createdAt;
    else own += 1;
    keep(state, next, size);
    result.stored.push(next);
  }
  return result;
}

// At most this many ids are read from one message.
const MAX_IDS = MAX_SUGGESTIONS_PER_BOARD;

const idsIn = (ids: unknown) =>
  (Array.isArray(ids) ? ids.slice(0, MAX_IDS) : []).filter((id): id is string => typeof id === "string");

/** Takes back `author`'s own suggestions among `ids`. Returns the ids that went. */
export function withdrawSuggestions(state: SuggestionState, author: Participant, ids: unknown) {
  return idsIn(ids).filter((id) => {
    const suggestion = state.byId.get(id);
    return suggestion !== undefined && sameAuthor(suggestion.author, author) && drop(state, id);
  });
}

/** Lets go of the suggestions among `ids`, which a member accepted or rejected. Returns the ids that went. */
export function resolveSuggestions(state: SuggestionState, ids: unknown) {
  return idsIn(ids).filter((id) => drop(state, id));
}

/**
 * Lets go of suggestions the board has overtaken: an addition whose element is on the board now (a member
 * accepted it), and changes and removals of an element that's gone (accepting a removal is removing it).
 * `changed` limits the look to those elements; without it, every suggestion is looked at, and so is its
 * age. Returns the ids that went, as accepted (an addition now on the board, a removal carried out) or gone.
 */
export function settleSuggestions(state: SuggestionState, board: Board, changed?: Iterable<string>, now = Date.now()) {
  const accepted: string[] = [];
  const gone: string[] = [];
  const ids = changed ? new Set(changed) : null;
  for (const suggestion of [...state.byId.values()]) {
    const about = suggestion.kind === "add" ? suggestion.element.id : suggestion.target;
    if (ids && !ids.has(about)) continue;
    const there = board.index.has(about);
    if (suggestion.kind === "add" ? there : !there) {
      drop(state, suggestion.id);
      (suggestion.kind === "change" ? gone : accepted).push(suggestion.id);
    } else if (!ids && now - suggestion.updatedAt > SUGGESTION_MAX_AGE_MS) {
      drop(state, suggestion.id);
      gone.push(suggestion.id);
    }
  }
  return { accepted, gone };
}
