import jwt from "jsonwebtoken";
import mongoose from "mongoose";
import { env } from "../config/env.js";
import { User } from "../models/user.model.js";
import { HttpError } from "./http-error.js";

// Every token is signed with the same secret, so each says what it is for in its
// `aud` claim, and each kind is only accepted where it belongs: the OAuth link
// ticket, state cookie, finished connection and sign-in code can't be used as logins.
const ALGORITHMS = ["HS256"];
export const SESSION = "inkboard:session";
export const OAUTH_LINK = "inkboard:oauth-link";
export const OAUTH_STATE = "inkboard:oauth-state";
export const OAUTH_CONNECT = "inkboard:oauth-connect";
export const OAUTH_LOGIN = "inkboard:oauth-login";

/**
 * A login token. It carries the account's `tokenVersion`: changing or resetting
 * the password bumps that, which ends every login made before (see `revokeSessions`).
 */
export function signToken(user) {
  return jwt.sign({ sub: user.id, tv: user.tokenVersion ?? 0 }, env.jwtSecret, {
    algorithm: "HS256",
    audience: SESSION,
    expiresIn: env.jwtExpiresIn,
  });
}

/** A short-lived token for one step of the OAuth flow (`audience` is OAUTH_LINK, OAUTH_STATE, OAUTH_CONNECT or OAUTH_LOGIN). */
export function signPurposeToken(audience, claims, expiresIn) {
  return jwt.sign(claims, env.jwtSecret, { algorithm: "HS256", audience, expiresIn });
}

/** The claims of a token made by `signPurposeToken`, or throws if it's invalid, expired or for another purpose. */
export function verifyPurposeToken(token, audience) {
  return jwt.verify(token, env.jwtSecret, { algorithms: ALGORITHMS, audience });
}

/** The claims of a login token, or throws. Other kinds of token are refused. */
export function verifyToken(token) {
  const claims = jwt.verify(token, env.jwtSecret, { algorithms: ALGORITHMS });
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
export async function userForToken(token) {
  let claims;
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
