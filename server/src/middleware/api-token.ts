import type { NextFunction, Request, Response } from "express";
import { HttpError } from "../lib/http-error.ts";
import { readApiToken } from "../services/api-tokens.ts";
import type { ApiScope } from "../services/api-tokens.ts";

// What `requireApiToken` adds to the request, besides `userId`.
declare module "express-serve-static-core" {
  interface Request {
    /** What the API token may do. */
    apiScope?: ApiScope;
  }
}

/**
 * For the public API: the request must come with one of the person's API tokens (see services/api-tokens.ts), which
 * sets `userId` as requireAuth does. A login token isn't one, and an API token works nowhere else.
 */
export async function requireApiToken(req: Request, res: Response, next: NextFunction) {
  const [scheme, token] = (req.get("authorization") ?? "").split(" ");
  if (scheme !== "Bearer" || !token) {
    return next(new HttpError(401, "Send an API token as `Authorization: Bearer ink_…`. Make one in Settings."));
  }
  try {
    const found = await readApiToken(token);
    if (!found) return next(new HttpError(401, "That API token isn't valid. It may have been deleted."));
    req.userId = found.userId;
    req.apiScope = found.scope;
    next();
  } catch (error) {
    next(error);
  }
}

/** Only for tokens that may change boards. Use after `requireApiToken`. */
export function requireWriteScope(req: Request, res: Response, next: NextFunction) {
  if (req.apiScope === "write") return next();
  next(new HttpError(403, "This token can only read boards. Make one that can change them in Settings."));
}
