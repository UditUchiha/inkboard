import type { NextFunction, Request, Response } from "express";
import { HttpError } from "../lib/http-error.ts";
import { userForToken } from "../lib/tokens.ts";

// What `requireAuth` adds to the request. Optional, because routes that don't use it (sign-in, say) never have them.
declare module "express-serve-static-core" {
  interface Request {
    /** The signed-in account's id. */
    userId?: string;
    /** When that login was issued, in seconds since 1970 (the token's `iat`). */
    loginIssuedAt?: number;
  }
}

// Connecting a provider or setting a first password lets someone sign in without the old
// password, so a login token that could be days old (and stolen) isn't enough for them.
export const RECENT_LOGIN_SECONDS = 15 * 60;

export async function requireAuth(req: Request, res: Response, next: NextFunction) {
  const [scheme, token] = (req.get("authorization") ?? "").split(" ");
  if (scheme !== "Bearer" || !token) {
    return next(new HttpError(401, "Log in to continue."));
  }
  try {
    const { user, issuedAt } = await userForToken(token);
    req.userId = user.id;
    req.loginIssuedAt = issuedAt;
    next();
  } catch (error) {
    next(error);
  }
}

/** Throws unless the person logged in recently. Use after `requireAuth`. */
export function assertRecentLogin(req: Request) {
  // Without a login time (used without `requireAuth` before it), the login doesn't count as recent: a missing
  // time would otherwise make the sum NaN, and NaN is never more than the limit.
  const issuedAt = req.loginIssuedAt;
  if (issuedAt === undefined || Date.now() / 1000 - issuedAt > RECENT_LOGIN_SECONDS) {
    throw new HttpError(403, "For your security, log out and log in again, then try this again.");
  }
}

/** Route version of `assertRecentLogin`. */
export function requireRecentLogin(req: Request, res: Response, next: NextFunction) {
  try {
    assertRecentLogin(req);
    next();
  } catch (error) {
    next(error);
  }
}
