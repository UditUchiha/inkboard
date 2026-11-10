import type { NextFunction, Request, Response } from "express";
import { HttpError } from "../lib/http-error.ts";
import { readApiToken } from "../services/api-tokens.ts";
import type { ApiScope } from "../services/api-tokens.ts";

declare module "express-serve-static-core" {
  interface Request {
    apiScope?: ApiScope;
  }
}

// An API token works only here, and a login token isn't one (see services/api-tokens.ts).
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

export function requireWriteScope(req: Request, res: Response, next: NextFunction) {
  if (req.apiScope === "write") return next();
  next(new HttpError(403, "This token can only read boards. Make one that can change them in Settings."));
}
