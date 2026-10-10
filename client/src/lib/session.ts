// Decisions about which login a tab keeps when it logs out. The stored login (localStorage) is shared by
// every tab of the app, so what one tab does to it can reach the others; these are kept apart from the
// provider so they can be tested without a browser.

/**
 * The account id (`sub`) inside a login token, or null if it isn't one. The signature isn't checked: this
 * is only for telling whether two tokens are for the same person, and the server checks every token it gets.
 */
export function tokenUserId(token: string) {
  try {
    const payload = token.split(".")[1].replaceAll("-", "+").replaceAll("_", "/");
    const { sub }: { sub?: unknown } = JSON.parse(atob(payload));
    return typeof sub === "string" ? sub : null;
  } catch {
    return null;
  }
}

/**
 * What a tab does when its login ends. `own` is the token the tab was using and `stored` the one in
 * localStorage, which may be newer (another tab logged in again) or another account's entirely.
 *
 * - `explicit`: the person chose to log out. This tab always ends up logged out; it never switches to
 *   another login, least of all another account's.
 * - Otherwise (the server refused the token): a newer login for the *same* account is adopted, as the
 *   password may just have been changed in another tab. One for a different account isn't: that account
 *   isn't who this tab was signed in as.
 *
 * `clearStored` is only true when the stored token is this tab's own (or there is none): a login that
 * isn't this tab's isn't ours to remove, so another tab keeps its login.
 */
export function logoutPlan({
  own,
  stored,
  explicit,
}: {
  own: string | null;
  stored: string | null;
  explicit: boolean;
}) {
  const newer = stored && stored !== own ? stored : null;
  const sameAccount =
    newer !== null && own != null && tokenUserId(newer) !== null && tokenUserId(newer) === tokenUserId(own);
  return {
    adopt: !explicit && sameAccount ? newer : null,
    clearStored: newer === null,
  };
}
