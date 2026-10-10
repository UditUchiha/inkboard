import { HttpError } from "../lib/http-error.js";
import { userForToken } from "../lib/tokens.js";

// Connecting a provider or setting a first password lets someone sign in without the old
// password, so a login token that could be days old (and stolen) isn't enough for them.
export const RECENT_LOGIN_SECONDS = 15 * 60;

export async function requireAuth(req, res, next) {
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
export function assertRecentLogin(req) {
  if (Date.now() / 1000 - req.loginIssuedAt > RECENT_LOGIN_SECONDS) {
    throw new HttpError(403, "For your security, log out and log in again, then try this again.");
  }
}

/** Route version of `assertRecentLogin`. */
export function requireRecentLogin(req, res, next) {
  try {
    assertRecentLogin(req);
    next();
  } catch (error) {
    next(error);
  }
}
