import type { Request } from "express";
import { env } from "../config/env.ts";

const requestUrl = (req: Request) => `${req.protocol}://${req.get("host")}`;

/**
 * Where this API is reached, for the callback address a sign-in provider sends people back to:
 * API_URL, or APP_URL when the server also hosts the app, or the address the request came in on.
 */
export const apiUrlFor = (req: Request) => env.apiUrl || env.appUrl || requestUrl(req);

/**
 * Where people open the app, for redirects into it and links in emails. When the client runs on its
 * own address (the Vite dev server, or a separate static site), requests come from one of the allowed
 * client origins, and links should point there. Without APP_URL, the Host header decides, so
 * production requires APP_URL (or Render's address, see emailLinkUrlFor) whenever email is on
 * (see config/env.ts). APP_URL is only what was set: Render's own onrender.com address is not
 * used here, or a custom domain would send people to a different site than they started on, where
 * the sign-in cookie isn't.
 */
export function clientUrlFor(req: Request) {
  if (env.appUrl) return env.appUrl;
  const origin = req.get("origin");
  return origin && env.clientOrigins.includes(origin) ? origin : requestUrl(req);
}

/**
 * The address links in emails point at. APP_URL when set; otherwise, on Render, the service's own
 * address (a request's Host header can't choose it); otherwise the same as clientUrlFor, which is only
 * safe without email, and production refuses to start that way (see config/env.ts).
 */
export const emailLinkUrlFor = (req: Request) => env.appUrl || env.renderUrl || clientUrlFor(req);
