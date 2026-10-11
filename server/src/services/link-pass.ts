import { randomBytes, timingSafeEqual } from "node:crypto";

// A board's link can ask for a password (see board.model.ts). Whoever gives it gets a pass, which their browser
// sends when it opens the board. The pass is the board's link key: a random string made with the password, kept
// on the server and given only to people who gave the password. So a pass opens only that board, and only until
// the password changes or is removed, which gives the board a new key (or none).

/** What a pass is checked against: the board's link key. */
export interface Keyed {
  linkKey?: string | null;
}

/** A new link key, for a new password. */
export const newLinkKey = () => randomBytes(24).toString("base64url");

/** The pass for a board's current password, or "" when its link asks for none. */
export const passFor = (board: Keyed) => board.linkKey ?? "";

/** Whether `pass` (anything a request sent) is the pass for the board's current password. */
export function isPassFor(board: Keyed, pass: unknown) {
  const expected = Buffer.from(passFor(board));
  if (expected.length === 0 || typeof pass !== "string") return false;
  const given = Buffer.from(pass);
  return given.length === expected.length && timingSafeEqual(given, expected);
}
