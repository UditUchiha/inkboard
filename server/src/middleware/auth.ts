import type { NextFunction, Request, Response } from "express";
import { HttpError } from "../lib/http-error.ts";
import { userForToken } from "../lib/tokens.ts";

declare module "express-serve-static-core" {
  interface Request {
    userId?: string;
    loginIssuedAt?: number;
  }
}

// connecting a provider or setting a first password works without the old password, so a possibly days-old (stolen)
// token isn't enough
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

// for routes guests can use too: sets `userId` when the request has a valid login, else goes on without one
export async function optionalAuth(req: Request, res: Response, next: NextFunction) {
  const [scheme, token] = (req.get("authorization") ?? "").split(" ");
  if (scheme === "Bearer" && token) {
    try {
      const { user, issuedAt } = await userForToken(token);
      req.userId = user.id;
      req.loginIssuedAt = issuedAt;
    } catch {
      // an expired or ended login counts as none
    }
  }
  next();
}

export function assertRecentLogin(req: Request) {
  // without a login time the login doesn't count as recent: a missing time would make the sum NaN, which is never more
  // than the limit
  const issuedAt = req.loginIssuedAt;
  if (issuedAt === undefined || Date.now() / 1000 - issuedAt > RECENT_LOGIN_SECONDS) {
    throw new HttpError(403, "For your security, log out and log in again, then try this again.");
  }
}

export function requireRecentLogin(req: Request, res: Response, next: NextFunction) {
  try {
    assertRecentLogin(req);
    next();
  } catch (error) {
    next(error);
  }
}
