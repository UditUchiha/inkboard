// Which login a tab keeps when it logs out. The stored login is shared by every tab; kept apart from the provider to
// test without a browser.

// The signature isn't checked: this only tells whether two tokens are the same person; the server checks every token.
export function tokenUserId(token: string) {
  try {
    const payload = token.split(".")[1].replaceAll("-", "+").replaceAll("_", "/");
    const { sub }: { sub?: unknown } = JSON.parse(atob(payload));
    return typeof sub === "string" ? sub : null;
  } catch {
    return null;
  }
}

// `explicit` logout always ends logged out here. Otherwise (token refused) a newer login for the same account is
// adopted (the password may have changed in another tab), a different account's isn't. `clearStored` only when the
// stored token is this tab's own.
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
