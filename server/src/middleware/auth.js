import { HttpError } from "../lib/http-error.js";
import { verifyToken } from "../lib/tokens.js";

export function requireAuth(req, res, next) {
  const [scheme, token] = (req.get("authorization") ?? "").split(" ");
  if (scheme !== "Bearer" || !token) {
    return next(new HttpError(401, "Log in to continue."));
  }
  try {
    req.userId = verifyToken(token).sub;
    next();
  } catch {
    next(new HttpError(401, "Your session has expired. Log in again."));
  }
}
