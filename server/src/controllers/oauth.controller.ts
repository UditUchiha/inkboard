import { createHash, randomBytes } from "node:crypto";
import type { CookieOptions, Request, Response } from "express";
import { env } from "../config/env.ts";
import { apiUrlFor, clientUrlFor } from "../lib/app-url.ts";
import { HttpError } from "../lib/http-error.ts";
import {
  OAUTH_CONNECT,
  OAUTH_LINK,
  OAUTH_LOGIN,
  OAUTH_STATE,
  signPurposeToken,
  signToken,
  verifyPurposeToken,
} from "../lib/tokens.ts";
import type { TokenClaims } from "../lib/tokens.ts";
import { OAUTH_PROVIDERS, User } from "../models/user.model.ts";
import type { OAuthProvider, UserDoc } from "../models/user.model.ts";
import { refreshUser } from "../realtime/index.js";
import { emailConfigured } from "../services/email.ts";

// Sign-in with Google or GitHub uses the authorization-code flow:
//   1. The app makes a random `bind` value, keeps it in the tab (sessionStorage) and sends the
//      browser to /api/auth/oauth/:provider?bind=<hash of it>. The server sends the browser on to the
//      provider, with a random `state` that's also kept in a short-lived signed cookie, along with
//      the hash.
//   2. The provider sends the browser back to .../callback with a code.
//   3. The server checks `state` against the cookie, swaps the code for the person's profile, finds
//      or creates their account, and hands the app a short-lived, single-use sign-in code (a signed
//      note of the account and the `bind` hash) in the URL fragment (fragments never reach server
//      logs). Never the login token itself.
//   4. The app posts the code with its `bind` to /api/auth/oauth/exchange (exchangeLoginCode), which
//      checks the two match and answers with the login token.
// Without steps 1 and 4, anyone could send a victim to /auth/callback#token=<their own login> and
// leave the victim's tab signed in to the attacker's account (login CSRF), where the victim's later
// clicks, such as on a verification email, would work for the attacker (C5). A code is useless to a
// tab that doesn't hold the `bind` it was made for, and the `bind` never leaves the tab that made it.
//
// Connecting a provider to an existing account starts from a signed-in POST, which answers
// with the URL for step 1 (holding a ticket) and a random `bind` value that the app keeps in
// the tab. Step 3 then connects nothing: it sends the app a signed note of the provider
// account, which the app hands back with `bind` in a signed-in POST (confirmLink). Without
// that, a link someone else made could be opened by the victim, attaching the victim's
// Google or GitHub account to the link-maker's account: the victim's tab has neither the
// link-maker's login nor their `bind`. None of it rests on a cookie set by the app's own
// requests, which browsers block as third-party when the app and the API are on different
// sites (M2, M10). The state cookie is set while the browser itself is at the API's address,
// so it's first-party.
//
// Failures go back to the app as an error code (`?error=expired&provider=google`) that the
// app turns into a message, so a link can't put text of its own on the page.

const STATE_COOKIE = "inkboard_oauth";
const STATE_TTL_SECONDS = 10 * 60;
const LINK_TTL_SECONDS = 5 * 60;
const COOKIE_PATH = "/api/auth/oauth";
const REQUEST_TIMEOUT_MS = 10_000;
// The app opens the code straight away, so it only has to survive the redirect.
const LOGIN_CODE_TTL_SECONDS = 2 * 60;
// A hash of the tab's `bind` (sha-256, base64url), as the app sends it.
const BIND_HASH = /^[A-Za-z0-9_-]{43}$/;

/** A sign-in that can't go ahead; `code` is what the app shows a message for (client/src/pages/AuthPages.jsx). */
class SignInError extends Error {
  // `declare` keeps this a type only: Node strips it, and the assignment below still creates the field.
  declare code: string;

  constructor(code: string) {
    super(code);
    this.code = code;
  }
}

/** The app's credentials with one provider. */
type OAuthClient = NonNullable<(typeof env.oauth)[OAuthProvider]>;

/** Who a provider says someone is. `email` is only ever one the provider has verified. */
interface ProviderProfile {
  id: string;
  email?: string | null;
  name?: string | null;
  avatarUrl: string | null;
}

// What the providers answer with, as far as this file reads it.
interface TokenResponse {
  access_token?: string;
  error_description?: string;
}
interface GoogleUserInfo {
  sub: string;
  email?: string;
  email_verified?: boolean;
  name?: string;
  picture?: string;
}
interface GitHubUser {
  id: number;
  login: string;
  name?: string | null;
  avatar_url?: string | null;
}
interface GitHubEmail {
  email: string;
  primary?: boolean;
  verified?: boolean;
}

interface ProviderConfig {
  label: string;
  authorizeUrl: string;
  scope: string;
  extraParams: Record<string, string>;
  fetchProfile(code: string, redirectUri: string, client: OAuthClient): Promise<ProviderProfile>;
}

/** A provider that is set up on this server, with the app's credentials for it. */
interface EnabledProvider extends ProviderConfig {
  name: OAuthProvider;
  client: OAuthClient;
}

// What each kind of signed note holds. Only this file signs tokens with these audiences, so what
// `verifyPurposeToken` hands back is known to have these claims.
interface LinkTicketClaims extends TokenClaims {
  sub: string;
  provider: string;
  bind: string;
}
interface StateClaims extends TokenClaims {
  nonce: string;
  provider: string;
  next: string;
  // Who the connection is for; null when it's a sign-in.
  linkUserId?: string | null;
  bind: string;
}
interface ConnectClaims extends TokenClaims {
  sub: string;
  provider: string;
  id: string;
  avatarUrl: string | null;
  bind: string;
}
interface LoginCodeClaims extends TokenClaims {
  sub: string;
  bind: string;
  jti?: string;
  exp: number;
}

const PROVIDERS: Record<OAuthProvider, ProviderConfig> = {
  google: {
    label: "Google",
    authorizeUrl: "https://accounts.google.com/o/oauth2/v2/auth",
    scope: "openid email profile",
    extraParams: { prompt: "select_account" },
    async fetchProfile(code, redirectUri, client) {
      const tokens = await postForm<TokenResponse>("https://oauth2.googleapis.com/token", {
        code,
        client_id: client.clientId,
        client_secret: client.clientSecret,
        redirect_uri: redirectUri,
        grant_type: "authorization_code",
      });
      const info = await getJson<GoogleUserInfo>(
        "https://openidconnect.googleapis.com/v1/userinfo",
        tokens.access_token,
      );
      return {
        id: info.sub,
        email: info.email_verified ? info.email : null,
        name: info.name,
        avatarUrl: info.picture ?? null,
      };
    },
  },
  github: {
    label: "GitHub",
    authorizeUrl: "https://github.com/login/oauth/authorize",
    scope: "read:user user:email",
    extraParams: {},
    async fetchProfile(code, redirectUri, client) {
      const tokens = await postForm<TokenResponse>("https://github.com/login/oauth/access_token", {
        code,
        client_id: client.clientId,
        client_secret: client.clientSecret,
        redirect_uri: redirectUri,
      });
      if (!tokens.access_token) throw new Error(tokens.error_description ?? "No access token");
      const [profile, emails] = await Promise.all([
        getJson<GitHubUser>("https://api.github.com/user", tokens.access_token),
        getJson<GitHubEmail[]>("https://api.github.com/user/emails", tokens.access_token),
      ]);
      const primary = emails.find((entry) => entry.primary && entry.verified) ?? emails.find((entry) => entry.verified);
      return {
        id: String(profile.id),
        email: primary?.email ?? null,
        name: profile.name || profile.login,
        avatarUrl: profile.avatar_url ?? null,
      };
    },
  },
};

// `Answer` is what the provider is expected to send back; nothing checks it.
async function postForm<Answer>(url: string, fields: Record<string, string>) {
  const response = await fetch(url, {
    method: "POST",
    headers: { "Content-Type": "application/x-www-form-urlencoded", Accept: "application/json" },
    body: new URLSearchParams(fields),
    signal: AbortSignal.timeout(REQUEST_TIMEOUT_MS),
  });
  if (!response.ok) throw new Error(`${url} responded ${response.status}`);
  return response.json() as Promise<Answer>;
}

async function getJson<Answer>(url: string, accessToken: string | undefined) {
  const response = await fetch(url, {
    headers: { Authorization: `Bearer ${accessToken}`, Accept: "application/json", "User-Agent": "Inkboard" },
    signal: AbortSignal.timeout(REQUEST_TIMEOUT_MS),
  });
  if (!response.ok) throw new Error(`${url} responded ${response.status}`);
  return response.json() as Promise<Answer>;
}

const enabledProviders = () => OAUTH_PROVIDERS.filter((name) => env.oauth[name]);

// A name from the URL may be anything. Only the providers' own keys count: a plain lookup would also find what every
// object has, such as "constructor".
const isProvider = (name: string): name is OAuthProvider => Object.hasOwn(PROVIDERS, name);

function providerFrom(req: Request): EnabledProvider {
  const name = String(req.params.provider);
  if (!isProvider(name) || !env.oauth[name]) {
    throw new HttpError(404, "That sign-in method isn't available.");
  }
  // `!env.oauth[name]` above throws when the client is missing, which the types can't follow through `name`.
  return { name, ...PROVIDERS[name], client: env.oauth[name]! };
}

// The provider sends people back to the API. With trust proxy enabled in production, req.protocol is the public one.
const callbackUrl = (req: Request, provider: string) => `${apiUrlFor(req)}/api/auth/oauth/${provider}/callback`;

// Only follow redirects to paths inside the app. Browsers read a backslash as a slash and drop tabs and
// newlines, so "/\evil.example" or "/<tab>/evil.example" would leave the site: neither is allowed anywhere.
const unsafeChar = (char: string) => char === "\\" || char <= "\u001f" || char === "\u007f";
export const safeNext = (value: unknown) =>
  typeof value === "string" && /^\/(?!\/)/.test(value) && ![...value].some(unsafeChar) ? value : "/boards";

const hashOf = (value: string) => createHash("sha256").update(value).digest("base64url");

// Sign-in codes that have been exchanged, by id, until they would have expired anyway. A code is only
// worth anything with its tab's `bind`, so this is a second lock: opening the same redirect twice
// (a back button, a copied URL) can't sign in twice. It's kept in memory, like the email limits, so
// with several server processes the short life and the `bind` are what limit a replay.
const spentCodes = new Map<string, number>();

/** Marks a sign-in code as used. False if it was already (or has no id). */
function spendLoginCode(id: string | undefined, expiresAt: number) {
  const now = Date.now() / 1000;
  // Codes all live as long as each other, so the oldest entries are the first to expire.
  for (const [spent, until] of spentCodes) {
    if (until >= now) break;
    spentCodes.delete(spent);
  }
  if (typeof id !== "string" || spentCodes.has(id)) return false;
  spentCodes.set(id, expiresAt);
  return true;
}

function readCookie(req: Request, name: string) {
  for (const part of (req.get("cookie") ?? "").split(";")) {
    const [key, ...rest] = part.trim().split("=");
    if (key === name) return decodeURIComponent(rest.join("="));
  }
  return null;
}

const cookieOptions = (): CookieOptions => ({
  httpOnly: true,
  sameSite: "lax", // sent on the provider's top-level redirect back to us
  secure: env.isProduction,
  path: COOKIE_PATH,
});

// Connecting a provider before the address is verified could hand the account to whoever
// signed up with it first. Without email set up there's no way to verify, so it's allowed.
const mustVerifyFirst = (user: Pick<UserDoc, "emailVerified">) => emailConfigured() && !user.emailVerified;

function failSignIn(req: Request, res: Response, code: string, to: string, provider: string, next?: string) {
  const params = new URLSearchParams({ error: code, provider });
  // A failed sign-in keeps where the person was headed, for when they try again.
  if (next && next !== "/boards") params.set("next", next);
  res.redirect(`${clientUrlFor(req)}${to}?${params}`);
}

export function listProviders(req: Request, res: Response) {
  res.json({
    providers: enabledProviders().map((name) => ({ id: name, label: PROVIDERS[name].label })),
    // Whether email verification and password reset are on (see services/email.ts).
    email: emailConfigured(),
  });
}

/**
 * A short-lived ticket that lets the browser start the OAuth flow as a signed-in person, to
 * connect a provider to their existing account, and the `bind` value the app keeps for
 * confirmLink. Only a hash of `bind` goes into the URLs.
 */
export async function createLinkTicket(req: Request, res: Response) {
  const { name, label } = providerFrom(req);
  const user = await User.findById(req.userId);
  if (!user) throw new HttpError(401, "This account no longer exists.");
  if (mustVerifyFirst(user)) throw new HttpError(403, `Verify your email address before connecting ${label}.`);

  const bind = randomBytes(24).toString("base64url");
  const claims = { sub: req.userId, provider: name, bind: hashOf(bind) };
  const ticket = signPurposeToken(OAUTH_LINK, claims, LINK_TTL_SECONDS);
  res.json({ url: `/api/auth/oauth/${name}?link=${encodeURIComponent(ticket)}`, bind });
}

export function startOAuth(req: Request, res: Response) {
  const provider = providerFrom(req);

  let link: { linkUserId: string | null | undefined; bind: string };
  if (req.query.link) {
    try {
      const ticket = verifyPurposeToken(String(req.query.link), OAUTH_LINK) as LinkTicketClaims;
      if (ticket.provider !== provider.name) throw new Error("wrong ticket");
      link = { linkUserId: ticket.sub, bind: ticket.bind };
    } catch {
      return failSignIn(req, res, "link-expired", "/settings", provider.name);
    }
  } else {
    // Signing in needs the tab's `bind` hash too, or what comes back couldn't be tied to this browser.
    const bind = String(req.query.bind ?? "");
    if (!BIND_HASH.test(bind))
      return failSignIn(req, res, "incomplete", "/login", provider.name, safeNext(req.query.next));
    link = { linkUserId: null, bind };
  }

  const nonce = randomBytes(24).toString("base64url");
  const state = signPurposeToken(
    OAUTH_STATE,
    { nonce, provider: provider.name, next: safeNext(req.query.next), ...link },
    STATE_TTL_SECONDS,
  );
  res.cookie(STATE_COOKIE, state, { ...cookieOptions(), maxAge: STATE_TTL_SECONDS * 1000 });

  const params = new URLSearchParams({
    client_id: provider.client.clientId,
    redirect_uri: callbackUrl(req, provider.name),
    response_type: "code",
    scope: provider.scope,
    state: nonce,
    ...provider.extraParams,
  });
  res.redirect(`${provider.authorizeUrl}?${params}`);
}

export async function finishOAuth(req: Request, res: Response) {
  const provider = providerFrom(req);

  let state: StateClaims;
  try {
    state = verifyPurposeToken(readCookie(req, STATE_COOKIE) ?? "", OAUTH_STATE) as StateClaims;
  } catch {
    return failSignIn(req, res, "expired", "/login", provider.name);
  }
  res.clearCookie(STATE_COOKIE, cookieOptions());

  const returnTo = state.linkUserId ? "/settings" : "/login";
  const fail = (code: string, to = "/login") => failSignIn(req, res, code, to, provider.name, state.next);
  if (state.provider !== provider.name || state.nonce !== req.query.state) return fail("unverified", returnTo);
  if (req.query.error || !req.query.code) return fail("cancelled", returnTo);

  let profile: ProviderProfile;
  try {
    profile = await provider.fetchProfile(String(req.query.code), callbackUrl(req, provider.name), provider.client);
  } catch (error) {
    // Anything can be thrown; the fetches throw Errors.
    console.error(`${provider.label} sign-in failed:`, (error as Error).message);
    return fail("provider-failed", returnTo);
  }

  try {
    if (state.linkUserId) {
      // Connected once the app confirms it (confirmLink). The note travels in the fragment, which
      // never reaches a server's logs.
      const note = { sub: state.linkUserId, provider: provider.name, id: profile.id, avatarUrl: profile.avatarUrl };
      const connect = signPurposeToken(OAUTH_CONNECT, { ...note, bind: state.bind }, LINK_TTL_SECONDS);
      const fragment = new URLSearchParams({ connect, provider: provider.name });
      return res.redirect(`${clientUrlFor(req)}/settings#${fragment}`);
    }
    const user = await findOrCreateUser(provider, profile);
    const claims = { sub: user.id, bind: state.bind, jti: randomBytes(16).toString("base64url") };
    const fragment = new URLSearchParams({
      code: signPurposeToken(OAUTH_LOGIN, claims, LOGIN_CODE_TTL_SECONDS),
      next: state.next,
    });
    return res.redirect(`${clientUrlFor(req)}/auth/callback#${fragment}`);
  } catch (error) {
    if (!(error instanceof SignInError)) console.error(error);
    return fail(error instanceof SignInError ? error.code : "failed", returnTo);
  }
}

/**
 * Trades the sign-in code the OAuth flow came back with for a login token, once the app shows it's the
 * tab that started the sign-in (it holds the `bind` the code was made for). The code works once.
 */
export async function exchangeLoginCode(
  req: Request<{}, unknown, { code?: unknown; bind?: unknown } | undefined>,
  res: Response,
) {
  let note: LoginCodeClaims;
  try {
    note = verifyPurposeToken(String(req.body?.code ?? ""), OAUTH_LOGIN) as LoginCodeClaims;
  } catch {
    throw new HttpError(400, "Sign-in took too long. Try again.");
  }
  const bind = req.body?.bind;
  // Checked before the code is used up, so someone holding only the code can't waste it.
  if (typeof bind !== "string" || bind.length > 200 || note.bind !== hashOf(bind)) {
    throw new HttpError(403, "This sign-in wasn't started in this browser tab. Try again.");
  }
  if (!spendLoginCode(note.jti, note.exp)) throw new HttpError(400, "That sign-in was already used. Try again.");
  const user = await User.findById(note.sub);
  if (!user) throw new HttpError(401, "This account no longer exists.");
  res.json({ token: signToken(user), user: user.toAccount() });
}

// Another account got there first (a sign-up or connect that ran at the same moment).
// Anything can be thrown; a duplicate-key error from MongoDB carries a numeric code.
const isDuplicate = (error: unknown) => (error as { code?: unknown } | null)?.code === 11000;

async function connectProvider(
  userId: string | undefined,
  provider: EnabledProvider,
  profile: Pick<ProviderProfile, "id" | "avatarUrl">,
) {
  const field = `${provider.name}Id` as const;
  const owner = await User.findOne({ [field]: profile.id });
  if (owner && owner.id !== userId) throw new SignInError("already-linked");
  const user = await User.findById(userId).select("+password +googleId +githubId");
  if (!user) throw new SignInError("no-account");
  if (mustVerifyFirst(user)) throw new SignInError("verify-first");
  user[field] = profile.id;
  user.avatarUrl ??= profile.avatarUrl;
  try {
    await user.save();
  } catch (error) {
    throw isDuplicate(error) ? new SignInError("already-linked") : error;
  }
  return user;
}

async function findOrCreateUser(provider: EnabledProvider, profile: ProviderProfile) {
  const field = `${provider.name}Id` as const;
  const existing = await User.findOne({ [field]: profile.id });
  if (existing) return existing;

  if (!profile.email) throw new SignInError("no-email");
  // Emails aren't verified at sign-up, so silently attaching a provider to an
  // existing password account could hand that account to whoever created it.
  // The owner connects the provider from their settings instead.
  if (await User.exists({ email: profile.email.toLowerCase() })) throw new SignInError("email-in-use");

  const name = (profile.name ?? "").trim().slice(0, 60) || profile.email.split("@")[0].slice(0, 60);
  // The provider only gives us verified addresses (see above), so this one is verified too.
  try {
    return await User.create({
      name,
      email: profile.email,
      emailVerified: true,
      [field]: profile.id,
      avatarUrl: profile.avatarUrl,
    });
  } catch (error) {
    if (!isDuplicate(error)) throw error;
    // The same person signing in twice at once: the second request finds the first one's account.
    const created = await User.findOne({ [field]: profile.id });
    if (created) return created;
    throw new SignInError("email-in-use");
  }
}

// What connectProvider can fail with, as an HTTP status and message.
const CONNECT_ERRORS: Record<string, (label: string) => [number, string]> = {
  "already-linked": (label) => [409, `That ${label} account is already connected to a different account.`],
  "verify-first": (label) => [403, `Verify your email address before connecting ${label}.`],
  "no-account": () => [401, "This account no longer exists."],
};

/**
 * Connects the provider account the OAuth flow came back with (the `connect` note), once the
 * app shows it's the same signed-in person, in the same tab, that asked to connect it.
 */
export async function confirmLink(
  req: Request<{ provider: string }, unknown, { connect?: unknown; bind?: unknown } | undefined>,
  res: Response,
) {
  const provider = providerFrom(req);
  let note: ConnectClaims;
  try {
    note = verifyPurposeToken(String(req.body?.connect ?? ""), OAUTH_CONNECT) as ConnectClaims;
  } catch {
    throw new HttpError(400, `Connecting ${provider.label} took too long. Try again.`);
  }
  const bind = req.body?.bind;
  const sameRequest =
    note.provider === provider.name &&
    note.sub === req.userId &&
    typeof bind === "string" &&
    note.bind === hashOf(bind);
  if (!sameRequest) {
    throw new HttpError(403, `This isn't the ${provider.label} connection you started here. Try again from Settings.`);
  }

  let user: UserDoc;
  try {
    user = await connectProvider(req.userId, provider, { id: note.id, avatarUrl: note.avatarUrl });
  } catch (error) {
    if (!(error instanceof SignInError)) throw error;
    const [status, message] = CONNECT_ERRORS[error.code](provider.label);
    throw new HttpError(status, message);
  }
  await refreshUser(user);
  res.json({ user: user.toAccount() });
}

/** Disconnects a provider, as long as the account keeps another way to sign in. */
export async function disconnectProvider(req: Request, res: Response) {
  const name = String(req.params.provider);
  if (!isProvider(name)) throw new HttpError(404, "That sign-in method isn't available.");
  const { label } = PROVIDERS[name];

  const user = await User.findById(req.userId).select("+password +googleId +githubId");
  if (!user) throw new HttpError(401, "This account no longer exists.");
  const otherWays =
    OAUTH_PROVIDERS.filter((other) => other !== name && user[`${other}Id`]).length + (user.password ? 1 : 0);
  if (otherWays === 0) {
    throw new HttpError(400, `Set a password first, so you can still log in without ${label}.`);
  }
  user[`${name}Id`] = undefined;
  await user.save();
  res.json({ user: user.toAccount() });
}
