import { createHash, randomBytes } from "node:crypto";
import type * as Api from "@inkboard/shared/api";
import { HttpError } from "../lib/http-error.ts";
import { API_SCOPES, ApiToken } from "../models/api-token.model.ts";
import { User } from "../models/user.model.ts";
import type { ObjectIdLike } from "./boards.ts";

// Tokens look like this, so they're easy to spot (in a leaked file, say) and can't be mistaken for logins.
const PREFIX = "ink_";
export const TOKEN_LIMITS = { perUser: 20 };
// A token's last use is written at most this often, not on every request.
const LAST_USED_EVERY_MS = 60 * 60 * 1000;

export type ApiScope = (typeof API_SCOPES)[number];

// Tokens are long and random, so a plain hash is enough to keep them (a password needs a slow one).
const hashOf = (token: string) => createHash("sha256").update(token).digest("base64url");

const serialize = (token: {
  id: string;
  name: string;
  start: string;
  scope: string;
  lastUsedAt?: Date | null;
  createdAt: Date;
}): Api.ApiTokenInfo => ({
  id: token.id,
  name: token.name,
  start: token.start,
  scope: token.scope as ApiScope,
  lastUsedAt: token.lastUsedAt ?? null,
  createdAt: token.createdAt,
});

/** Makes a token for `userId`. The token itself is in the reply only this once; afterwards only its start is shown. */
export async function createApiToken(userId: ObjectIdLike, name: unknown, scope: unknown) {
  const label = typeof name === "string" ? name.trim() : "";
  if (!label) throw new HttpError(400, "Give the token a name, so you know what it's for.");
  if (label.length > 60) throw new HttpError(400, "Use 60 characters or fewer for the name.");
  if (!API_SCOPES.includes(scope as ApiScope)) throw new HttpError(400, "Choose whether the token can change boards.");
  if ((await ApiToken.countDocuments({ user: userId })) >= TOKEN_LIMITS.perUser) {
    throw new HttpError(400, `You have ${TOKEN_LIMITS.perUser} tokens, the most you can. Delete one you don't use.`);
  }
  const token = PREFIX + randomBytes(32).toString("base64url");
  const saved = await ApiToken.create({
    user: userId,
    name: label,
    hash: hashOf(token),
    start: token.slice(0, PREFIX.length + 6),
    scope: scope as ApiScope, // checked above
  });
  return { token, info: serialize(saved) };
}

export async function listApiTokens(userId: ObjectIdLike) {
  const tokens = await ApiToken.find({ user: userId }).sort({ createdAt: -1 });
  return tokens.map(serialize);
}

export async function deleteApiToken(userId: ObjectIdLike, tokenId: unknown) {
  const { deletedCount } = await ApiToken.deleteOne({ _id: String(tokenId), user: userId }).catch(() => ({
    deletedCount: 0, // not an id at all
  }));
  if (deletedCount === 0) throw new HttpError(404, "That token doesn't exist any more.");
}

/** Whose token this is and what it may do, or null when it isn't one (or its account is gone). */
export async function readApiToken(token: string): Promise<{ userId: string; scope: ApiScope } | null> {
  if (!token.startsWith(PREFIX)) return null;
  const found = await ApiToken.findOne({ hash: hashOf(token) });
  if (!found || !(await User.exists({ _id: found.user }))) return null;
  if (!found.lastUsedAt || Date.now() - found.lastUsedAt.getTime() > LAST_USED_EVERY_MS) {
    await ApiToken.updateOne({ _id: found._id }, { $set: { lastUsedAt: new Date() } });
  }
  return { userId: String(found.user), scope: found.scope as ApiScope };
}
