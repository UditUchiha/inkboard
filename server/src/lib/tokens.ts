import jwt from "jsonwebtoken";
import type { Algorithm } from "jsonwebtoken";
import mongoose from "mongoose";
import { env } from "../config/env.ts";
import type { TokenLifetime } from "../config/env.ts";
import { User } from "../models/user.model.ts";
import { HttpError } from "./http-error.ts";

// Every token is signed with the same secret, so each says what it is for in its
// `aud` claim, and each kind is only accepted where it belongs: the OAuth link
// ticket, state cookie, finished connection and sign-in code can't be used as logins.
const ALGORITHMS: Algorithm[] = ["HS256"];
export const SESSION = "inkboard:session";
export const OAUTH_LINK = "inkboard:oauth-link";
export const OAUTH_STATE = "inkboard:oauth-state";
export const OAUTH_CONNECT = "inkboard:oauth-connect";
export const OAUTH_LOGIN = "inkboard:oauth-login";

/** The claims every token has, plus whatever the OAuth steps put in theirs. */
export interface TokenClaims {
  sub?: string;
  aud?: string | string[];
  iat?: number;
  // The account's `tokenVersion` when a login was issued.
  tv?: number;
  // Only the old link tickets, from before tokens had an audience.
  purpose?: unknown;
  [claim: string]: unknown;
}

/**
 * A login token. It carries the account's `tokenVersion`: changing or resetting
 * the password bumps that, which ends every login made before (see `revokeSessions`).
 */
export function signToken(user: { id: string; tokenVersion?: number | null }) {
  return jwt.sign({ sub: user.id, tv: user.tokenVersion ?? 0 }, env.jwtSecret, {
    algorithm: "HS256",
    audience: SESSION,
    expiresIn: env.jwtExpiresIn,
  });
}

/** A short-lived token for one step of the OAuth flow (`audience` is OAUTH_LINK, OAUTH_STATE, OAUTH_CONNECT or OAUTH_LOGIN). */
export function signPurposeToken(audience: string, claims: object, expiresIn: TokenLifetime) {
  return jwt.sign(claims, env.jwtSecret, { algorithm: "HS256", audience, expiresIn });
}

/** The claims of a token made by `signPurposeToken`, or throws if it's invalid, expired or for another purpose. */
export function verifyPurposeToken(token: string, audience: string) {
  // Every token this server signs has an object payload, so `verify` never returns its string form.
  return jwt.verify(token, env.jwtSecret, { algorithms: ALGORITHMS, audience }) as TokenClaims;
}

/** The claims of a login token, or throws. Other kinds of token are refused. */
export function verifyToken(token: string) {
  // As above: the payload is an object.
  const claims = jwt.verify(token, env.jwtSecret, { algorithms: ALGORITHMS }) as TokenClaims;
  // Logins issued before tokens had an audience carry none (and no `purpose`, which
  // the old link tickets did), so they stay valid until they expire.
  const legacy = claims.aud === undefined && claims.purpose === undefined;
  if ((claims.aud !== SESSION && !legacy) || typeof claims.sub !== "string") throw new Error("Not a login token");
  return claims;
}

/**
 * The account a login token belongs to, or an HttpError(401) if the token is bad,
 * expired or was revoked. Logins from before `tokenVersion` existed count as version 0.
 */
export async function userForToken(token: string) {
  let claims: TokenClaims;
  try {
    claims = verifyToken(token);
  } catch {
    throw new HttpError(401, "Your session has expired. Log in again.");
  }
  const user = mongoose.isValidObjectId(claims.sub) ? await User.findById(claims.sub) : null;
  if (!user || (user.tokenVersion ?? 0) !== (claims.tv ?? 0)) {
    throw new HttpError(401, "Your session has expired. Log in again.");
  }
  return { user, issuedAt: claims.iat };
}
