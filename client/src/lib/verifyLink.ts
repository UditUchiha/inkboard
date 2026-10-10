// What the page behind a verification link shows. The link only verifies the account it was sent for, for
// someone logged in to it (see verifyEmail on the server), so the page has to say who is logged in and
// give a way out when that's the wrong account.

import type { AccountUser } from "./api";
import type { AuthStatus } from "../providers/AuthProvider";

export type VerifyView = "loading" | "offline" | "login" | "switch" | "confirm";

/**
 * `status` is the auth status, `user` the signed-in account (or null), and `linkEmail` the address
 * the link says it was sent to (the `email` in its address: only a hint for what's shown, since a
 * link can say anything; the server decides). One of:
 * - "loading": the account is still loading;
 * - "offline": the account couldn't be loaded, so nothing can be said about it yet (try again);
 * - "login": nobody is logged in;
 * - "switch": the account logged in isn't the one the link was sent to;
 * - "confirm": ready to verify the logged-in account.
 */
export function verifyView({
  status,
  user,
  linkEmail,
}: {
  status: AuthStatus;
  user: Pick<AccountUser, "email"> | null;
  linkEmail?: string | null;
}): VerifyView {
  if (status === "loading") return "loading";
  if (status === "offline") return "offline";
  if (status !== "authenticated" || !user) return "login";
  if (linkEmail && linkEmail.trim().toLowerCase() !== user.email.toLowerCase()) return "switch";
  return "confirm";
}
