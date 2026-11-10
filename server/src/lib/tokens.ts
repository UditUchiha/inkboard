import jwt from "jsonwebtoken";
import type { Algorithm } from "jsonwebtoken";
import mongoose from "mongoose";
import { env } from "../config/env.ts";
import type { TokenLifetime } from "../config/env.ts";
import { User } from "../models/user.model.ts";
import { HttpError } from "./http-error.ts";

// Every token shares one secret, so each says what it's for in `aud` and is accepted only where it belongs: the OAuth
// ticket, state cookie, finished connection and sign-in code can't be used as logins.
const ALGORITHMS: Algorithm[] = ["HS256"];
export const SESSION = "inkboard:session";
export const OAUTH_LINK = "inkboard:oauth-link";
export const OAUTH_STATE = "inkboard:oauth-state";
export const OAUTH_CONNECT = "inkboard:oauth-connect";
export const OAUTH_LOGIN = "inkboard:oauth-login";

export interface TokenClaims {
  sub?: string;
  aud?: string | string[];
  iat?: number;
  tv?: number;
  purpose?: unknown;
  [claim: string]: unknown;
}

// carries the account's `tokenVersion`: changing or resetting the password bumps it, ending every earlier login (see
// `revokeSessions`)
export function signToken(user: { id: string; tokenVersion?: number | null }) {
  return jwt.sign({ sub: user.id, tv: user.tokenVersion ?? 0 }, env.jwtSecret, {
    algorithm: "HS256",
    audience: SESSION,
    expiresIn: env.jwtExpiresIn,
  });
}

export function signPurposeToken(audience: string, claims: object, expiresIn: TokenLifetime) {
  return jwt.sign(claims, env.jwtSecret, { algorithm: "HS256", audience, expiresIn });
}

export function verifyPurposeToken(token: string, audience: string) {
  return jwt.verify(token, env.jwtSecret, { algorithms: ALGORITHMS, audience }) as TokenClaims;
}

export function verifyToken(token: string) {
  const claims = jwt.verify(token, env.jwtSecret, { algorithms: ALGORITHMS }) as TokenClaims;
  // logins from before tokens had an audience carry none (and no `purpose`, as old link tickets did), so they stay
  // valid until they expire
  const legacy = claims.aud === undefined && claims.purpose === undefined;
  if ((claims.aud !== SESSION && !legacy) || typeof claims.sub !== "string") throw new Error("Not a login token");
  return claims;
}

// logins from before `tokenVersion` existed count as version 0
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
