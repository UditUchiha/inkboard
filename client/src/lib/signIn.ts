// The tab's half of signing in with Google or GitHub (see server/src/controllers/oauth.controller.ts).
// Starting a sign-in makes a random `bind` that stays in this tab's sessionStorage; only a hash of it
// goes out in the URL. The redirect at the end carries a code that is only good with that `bind`, so
// a redirect someone made elsewhere (login CSRF: "open this link and you're signed in as me") finds no
// `bind` here and signs nobody in.

import type { Session } from "./api";

const BIND_KEY = "inkboard.signin";

function base64url(bytes: Uint8Array) {
  return btoa(String.fromCharCode(...bytes))
    .replaceAll("+", "-")
    .replaceAll("/", "_")
    .replace(/=+$/, "");
}

/** The value the server gets in place of `bind`: its SHA-256, base64url. */
export async function hashBind(bind: string) {
  return base64url(new Uint8Array(await crypto.subtle.digest("SHA-256", new TextEncoder().encode(bind))));
}

/** Makes a `bind`, keeps it in this tab, and returns its hash for the start URL; null if the tab can't keep it. */
export async function startSignIn() {
  const bind = base64url(crypto.getRandomValues(new Uint8Array(24)));
  try {
    sessionStorage.setItem(BIND_KEY, bind);
  } catch {
    return null; // without somewhere to keep it, the sign-in couldn't be finished
  }
  return hashBind(bind);
}

export function readSignInBind() {
  try {
    return sessionStorage.getItem(BIND_KEY);
  } catch {
    return null;
  }
}

export function forgetSignInBind() {
  try {
    sessionStorage.removeItem(BIND_KEY);
  } catch {
    // Nothing kept, nothing to forget.
  }
}

/**
 * Finishes a sign-in: trades the `code` from the redirect, with this tab's `bind`, for a login. `exchange`
 * does the request (`api.exchangeOAuthCode`). Resolves with
 * - { outcome: "signed-in", session }, the `{ token, user }` to start a session with;
 * - { outcome: "offline" }, when the server couldn't be reached (the `bind` is kept, to try again);
 * - { outcome: "incomplete" }, when there's no code, or no `bind` in this tab (so the sign-in wasn't
 *   started here: nobody is logged in), or the server refused them.
 */
type SignInResult = { outcome: "signed-in"; session: Session } | { outcome: "offline" } | { outcome: "incomplete" };

export async function completeSignIn({
  code,
  bind = readSignInBind(),
  exchange,
  forget = forgetSignInBind,
}: {
  code?: string | null;
  bind?: string | null;
  exchange: (input: { code: string; bind: string }) => Promise<Session>;
  forget?: () => void;
}): Promise<SignInResult> {
  if (!code || !bind) return { outcome: "incomplete" };
  try {
    const session = await exchange({ code, bind });
    forget();
    return { outcome: "signed-in", session };
  } catch (error) {
    // `exchange` is api.exchangeOAuthCode, which rejects with an ApiError (it has a `status`).
    if ((error as { status?: unknown } | null)?.status === 0) return { outcome: "offline" };
    forget();
    return { outcome: "incomplete" };
  }
}
