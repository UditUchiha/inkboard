// Errors come back as a *code* (?error=expired&provider=google), never text, so a link can't put words of its own into an
// official-looking message. Codes come from server/src/controllers/oauth.controller.ts; `next` is only followed inside the app.

const PROVIDER_LABELS: Record<string, string> = { google: "Google", github: "GitHub" };

export const providerLabel = (provider: string) => PROVIDER_LABELS[provider] ?? "your account";

export const isProvider = (provider: string) => Object.hasOwn(PROVIDER_LABELS, provider);

const MESSAGES: Record<string, (label: string) => string> = {
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

export function signInErrorMessage(code: string, provider: string) {
  const message = Object.hasOwn(MESSAGES, code) ? MESSAGES[code] : () => "Something went wrong. Try again.";
  return message(providerLabel(provider));
}

export function loginWithError(code: string, next?: string | null) {
  const params = new URLSearchParams({ error: code });
  if (next && next !== "/boards") params.set("next", next);
  return `/login?${params}`;
}

// The fragment goes along: it can hold what a provider connection brings back (/settings#connect=...), lost otherwise.
export const loginPathFor = ({
  pathname,
  search = "",
  hash = "",
}: {
  pathname: string;
  search?: string;
  hash?: string;
}) => `/login?next=${encodeURIComponent(pathname + search + hash)}`;

// Browsers read a backslash as a slash and drop tabs and newlines, so "/\evil.example" or "/<tab>/evil.example"
// would lead to another site (and react-router refuses to go there, which crashes the page).
const unsafeChar = (char: string) => char === "\\" || char <= "\u001f" || char === "\u007f";

export function safeNext(value: unknown) {
  const inside = typeof value === "string" && /^\/(?!\/)/.test(value) && ![...value].some(unsafeChar);
  return inside ? value : "/boards";
}
