import { randomBytes, timingSafeEqual } from "node:crypto";

// A board's link can ask for a password (see board.model.ts). Whoever gives it gets a pass: the board's link key, a random
// string made with the password and given only to people who gave it. So a pass opens only that board, and only until the
// password changes or is removed, which gives the board a new key (or none).

export interface Keyed {
  linkKey?: string | null;
}

export const newLinkKey = () => randomBytes(24).toString("base64url");

export const passFor = (board: Keyed) => board.linkKey ?? "";

export function isPassFor(board: Keyed, pass: unknown) {
  const expected = Buffer.from(passFor(board));
  if (expected.length === 0 || typeof pass !== "string") return false;
  const given = Buffer.from(pass);
  return given.length === expected.length && timingSafeEqual(given, expected);
}
