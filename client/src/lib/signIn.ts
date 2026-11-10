// Sign in with Google or GitHub (server/src/controllers/oauth.controller.ts): a random `bind` stays in this tab's
// sessionStorage and only its hash goes out in the URL. The redirect's code is only good with that `bind`, so a
// redirect made elsewhere (login CSRF) finds none and signs nobody in.

import type { Session } from "./api";

const BIND_KEY = "inkboard.signin";

function base64url(bytes: Uint8Array) {
  return btoa(String.fromCharCode(...bytes))
    .replaceAll("+", "-")
    .replaceAll("/", "_")
    .replace(/=+$/, "");
}

export async function hashBind(bind: string) {
  return base64url(new Uint8Array(await crypto.subtle.digest("SHA-256", new TextEncoder().encode(bind))));
}

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

// Resolves signed-in, offline (the `bind` is kept to try again) or incomplete (no code or `bind`, or the server refused
// them).
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
