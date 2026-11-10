// Finding "@Name" mentions in comment text. Kept apart from the components so it can be tested.

/** Someone who can be mentioned. */
export type Mentionable = { id: string; name: string };

/** Where a mention sits in a text: its "@" is at `start`, and it ends before `end`. */
export type Mention = { start: number; end: number; name: string };

/** A piece of a text, and whether it is a mention. */
export type Piece = { text: string; mention: boolean };

const WORD_CHARACTER = /[\p{L}\p{N}_]/u;

/** Matches "@" at the end of `before` (the text up to the caret), capturing what was typed after it. */
export const MENTION_AT_CARET = /(^|\s)@(\S*)$/;

/**
 * Where each "@Name" sits in `text`, as { start, end, name } in order.
 * The longest name wins when one is the start of another ("@Ann Lee" is not
 * "@Ann"), and a name only counts when it isn't followed by more of a word
 * ("@Anna" is not "@Ann"), nor preceded by one ("a@Ann.com" is an address).
 */
export function findMentions(text: string, names: string[]): Mention[] {
  const candidates = [...new Set(names)].filter(Boolean).sort((a, b) => b.length - a.length);
  const found: Mention[] = [];
  let from = 0;
  while (candidates.length > 0) {
    const at = text.indexOf("@", from);
    if (at === -1) break;
    if (at > 0 && WORD_CHARACTER.test(text[at - 1])) {
      from = at + 1;
      continue;
    }
    const name = candidates.find((candidate) => {
      if (!text.startsWith(candidate, at + 1)) return false;
      const next = text[at + 1 + candidate.length];
      return next === undefined || !WORD_CHARACTER.test(next);
    });
    if (name) {
      const end = at + 1 + name.length;
      found.push({ start: at, end, name });
      from = end;
    } else {
      from = at + 1;
    }
  }
  return found;
}

/** The ids of picked people whose "@Name" is still in the text. */
export function activeMentions(text: string, members: Mentionable[], ids: string[]): string[] {
  const mentioned = new Set(
    findMentions(
      text,
      members.map((member) => member.name),
    ).map((mention) => mention.name),
  );
  return ids.filter((id) => {
    const member = members.find((candidate) => candidate.id === id);
    return member && mentioned.has(member.name);
  });
}

/** The text cut into pieces, each marked as a mention or plain: [{ text, mention }]. */
export function splitMentions(text: string, names: string[]): Piece[] {
  const pieces: Piece[] = [];
  let cursor = 0;
  for (const { start, end } of findMentions(text, names)) {
    if (start > cursor) pieces.push({ text: text.slice(cursor, start), mention: false });
    pieces.push({ text: text.slice(start, end), mention: true });
    cursor = end;
  }
  if (cursor < text.length) pieces.push({ text: text.slice(cursor), mention: false });
  return pieces;
}

/** True while an input method (Japanese, Chinese, Korean...) is still composing: Enter then confirms the text, not the form. */
export const isComposing = (event: { nativeEvent?: { isComposing?: boolean }; keyCode?: number }): boolean =>
  Boolean(event.nativeEvent?.isComposing) || event.keyCode === 229;
