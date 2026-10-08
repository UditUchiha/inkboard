import { env } from "../config/env.js";

/** Where the app is served, for OAuth redirects: APP_URL, or the address the request came in on. */
export const appUrlFor = (req) => env.appUrl || `${req.protocol}://${req.get("host")}`;

/**
 * Where people open the app, for links in emails. When the client runs on its
 * own address (the Vite dev server, or a separate static site), requests come
 * from one of the allowed client origins, and links should point there.
 */
export function clientUrlFor(req) {
  if (env.appUrl) return env.appUrl;
  const origin = req.get("origin");
  return origin && env.clientOrigins.includes(origin) ? origin : appUrlFor(req);
}
