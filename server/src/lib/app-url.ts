import type { Request } from "express";
import { env } from "../config/env.ts";

const requestUrl = (req: Request) => `${req.protocol}://${req.get("host")}`;

// the callback address a sign-in provider sends people back to: API_URL, else APP_URL when the server hosts the app, else the request's address
export const apiUrlFor = (req: Request) => env.apiUrl || env.appUrl || requestUrl(req);

// Where people open the app, for redirects into it and links in emails. Without APP_URL the Host header decides, so
// production requires APP_URL (or Render's address, see emailLinkUrlFor) when email is on (see config/env.ts). Render's
// onrender.com address is not used here: a custom domain would send people to a different site than they started on,
// where the sign-in cookie isn't.
export function clientUrlFor(req: Request) {
  if (env.appUrl) return env.appUrl;
  const origin = req.get("origin");
  return origin && env.clientOrigins.includes(origin) ? origin : requestUrl(req);
}

// APP_URL, else on Render the service's own address (the Host header can't choose it), else clientUrlFor, which is only
// safe without email; production refuses to start that way (see config/env.ts)
export const emailLinkUrlFor = (req: Request) => env.appUrl || env.renderUrl || clientUrlFor(req);
