// The link only verifies the account it was sent for, for someone logged in to it, so the page says who is logged in and offers a way out.

import type { AccountUser } from "./api";
import type { AuthStatus } from "../providers/AuthProvider";

export type VerifyView = "loading" | "offline" | "login" | "switch" | "confirm";

// `linkEmail` (the link's `email`) is only a hint since a link can say anything; the server decides.
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
