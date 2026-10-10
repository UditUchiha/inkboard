// What sign-in links bring in their address, made safe to use. A sign-in with Google or GitHub that fails
// sends the person back with an error *code* (?error=expired&provider=google), never text, so a link can't
// put words of its own into an official-looking message. The codes come from
// server/src/controllers/oauth.controller.js. Where to go next (?next=/board/…) is only followed inside the app.

const PROVIDER_LABELS = { google: "Google", github: "GitHub" };

/** The provider's display name, or "your account" for anything that isn't one we know. */
export const providerLabel = (provider) => PROVIDER_LABELS[provider] ?? "your account";

/** Whether `provider` (from the URL) is one of ours. */
export const isProvider = (provider) => Object.hasOwn(PROVIDER_LABELS, provider);

const MESSAGES = {
  expired: () => "Sign-in took too long or was started in another browser. Try again.",
  unverified: () => "Sign-in couldn't be verified. Try again.",
  cancelled: (label) => `${label} sign-in was cancelled.`,
  "provider-failed": (label) => `${label} sign-in didn't work. Try again in a moment.`,
  "no-email": (label) => `Your ${label} account has no verified email address, so it can't be used to sign in.`,
  "email-in-use": (label) =>
    `An account with that email already exists. Log in with your password, then connect ${label} in Settings.`,
  "already-linked": (label) => `That ${label} account is already connected to a different account.`,
  "verify-first": (label) => `Verify your email address before connecting ${label}.`,
  "link-expired": () => "That link has expired. Try connecting again from your settings.",
  "no-account": () => "This account no longer exists.",
  incomplete: () => "Sign-in didn't finish. Try again.",
};

/** The message for an error code from the URL; anything unknown gets the general one. */
export function signInErrorMessage(code, provider) {
  const message = Object.hasOwn(MESSAGES, code) ? MESSAGES[code] : () => "Something went wrong. Try again.";
  return message(providerLabel(provider));
}

/** The log in page with an error code, keeping where the person was headed (`next`), so trying again still gets them there. */
export function loginWithError(code, next) {
  const params = new URLSearchParams({ error: code });
  if (next && next !== "/boards") params.set("next", next);
  return `/login?${params}`;
}

/**
 * The log in page for someone who isn't logged in, coming back to `location` afterwards. The fragment goes
 * along: it can hold what a Google or GitHub connection is bringing back (/settings#connect=...), which
 * would otherwise be lost when the login ran out while the person was away.
 */
export const loginPathFor = ({ pathname, search = "", hash = "" }) =>
  `/login?next=${encodeURIComponent(pathname + search + hash)}`;

// Browsers read a backslash as a slash and drop tabs and newlines, so "/\evil.example" or "/<tab>/evil.example"
// would lead to another site (and react-router refuses to go there, which crashes the page).
const unsafeChar = (char) => char === "\\" || char <= "\u001f" || char === "\u007f";

/** `value` if it's a path inside the app, which a link may send people on to after signing in; otherwise /boards. */
export function safeNext(value) {
  const inside = typeof value === "string" && /^\/(?!\/)/.test(value) && ![...value].some(unsafeChar);
  return inside ? value : "/boards";
}
