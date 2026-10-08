import { randomBytes } from "node:crypto";
import jwt from "jsonwebtoken";
import { env } from "../config/env.js";
import { appUrlFor } from "../lib/app-url.js";
import { HttpError } from "../lib/http-error.js";
import { signToken } from "../lib/tokens.js";
import { OAUTH_PROVIDERS, User } from "../models/user.model.js";
import { refreshUser } from "../realtime/index.js";
import { emailConfigured } from "../services/email.js";

// Sign-in with Google or GitHub uses the authorization-code flow:
//   1. /api/auth/oauth/:provider sends the browser to the provider, with a random
//      `state` that's also kept in a short-lived signed cookie.
//   2. The provider sends the browser back to .../callback with a code.
//   3. The server checks `state` against the cookie, swaps the code for the
//      person's profile, finds or creates their account, and hands the app a
//      login token in the URL fragment (fragments never reach server logs).

const STATE_COOKIE = "inkboard_oauth";
const STATE_TTL_SECONDS = 10 * 60;
const COOKIE_PATH = "/api/auth/oauth";

const PROVIDERS = {
  google: {
    label: "Google",
    authorizeUrl: "https://accounts.google.com/o/oauth2/v2/auth",
    scope: "openid email profile",
    extraParams: { prompt: "select_account" },
    async fetchProfile(code, redirectUri, client) {
      const tokens = await postForm("https://oauth2.googleapis.com/token", {
        code,
        client_id: client.clientId,
        client_secret: client.clientSecret,
        redirect_uri: redirectUri,
        grant_type: "authorization_code",
      });
      const info = await getJson("https://openidconnect.googleapis.com/v1/userinfo", tokens.access_token);
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
      const tokens = await postForm("https://github.com/login/oauth/access_token", {
        code,
        client_id: client.clientId,
        client_secret: client.clientSecret,
        redirect_uri: redirectUri,
      });
      if (!tokens.access_token) throw new Error(tokens.error_description ?? "No access token");
      const [profile, emails] = await Promise.all([
        getJson("https://api.github.com/user", tokens.access_token),
        getJson("https://api.github.com/user/emails", tokens.access_token),
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

async function postForm(url, fields) {
  const response = await fetch(url, {
    method: "POST",
    headers: { "Content-Type": "application/x-www-form-urlencoded", Accept: "application/json" },
    body: new URLSearchParams(fields),
  });
  if (!response.ok) throw new Error(`${url} responded ${response.status}`);
  return response.json();
}

async function getJson(url, accessToken) {
  const response = await fetch(url, {
    headers: { Authorization: `Bearer ${accessToken}`, Accept: "application/json", "User-Agent": "Inkboard" },
  });
  if (!response.ok) throw new Error(`${url} responded ${response.status}`);
  return response.json();
}

const enabledProviders = () => OAUTH_PROVIDERS.filter((name) => env.oauth[name]);

function providerFrom(req) {
  const name = req.params.provider;
  if (!PROVIDERS[name] || !env.oauth[name]) {
    throw new HttpError(404, "That sign-in method isn't available.");
  }
  return { name, ...PROVIDERS[name], client: env.oauth[name] };
}

// With trust proxy enabled in production, req.protocol is the public one.
const baseUrl = appUrlFor;
const callbackUrl = (req, provider) => `${baseUrl(req)}/api/auth/oauth/${provider}/callback`;

// Only follow redirects to paths inside the app.
const safeNext = (value) =>
  typeof value === "string" && value.startsWith("/") && !value.startsWith("//") ? value : "/boards";

function readCookie(req, name) {
  for (const part of (req.get("cookie") ?? "").split(";")) {
    const [key, ...rest] = part.trim().split("=");
    if (key === name) return decodeURIComponent(rest.join("="));
  }
  return null;
}

const cookieOptions = () => ({
  httpOnly: true,
  sameSite: "lax", // sent on the provider's top-level redirect back to us
  secure: env.isProduction,
  path: COOKIE_PATH,
});

export function listProviders(req, res) {
  res.json({
    providers: enabledProviders().map((name) => ({ id: name, label: PROVIDERS[name].label })),
    // Whether email verification and password reset are on (see services/email.js).
    email: emailConfigured(),
  });
}

/**
 * A short-lived ticket that lets the browser start the OAuth flow as a signed-in
 * person, to connect a provider to their existing account.
 */
export function createLinkTicket(req, res) {
  const { name } = providerFrom(req);
  const ticket = jwt.sign({ sub: req.userId, purpose: "oauth-link", provider: name }, env.jwtSecret, {
    expiresIn: 300,
  });
  res.json({ url: `/api/auth/oauth/${name}?link=${encodeURIComponent(ticket)}` });
}

export function startOAuth(req, res) {
  const provider = providerFrom(req);

  let linkUserId = null;
  if (req.query.link) {
    try {
      const ticket = jwt.verify(String(req.query.link), env.jwtSecret);
      if (ticket.purpose !== "oauth-link" || ticket.provider !== provider.name) throw new Error("wrong ticket");
      linkUserId = ticket.sub;
    } catch {
      throw new HttpError(400, "That link has expired. Try connecting again from your settings.");
    }
  }

  const nonce = randomBytes(24).toString("base64url");
  const state = jwt.sign(
    { nonce, provider: provider.name, next: safeNext(req.query.next), linkUserId },
    env.jwtSecret,
    { expiresIn: STATE_TTL_SECONDS },
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

export async function finishOAuth(req, res) {
  const provider = providerFrom(req);
  const fail = (message, to = "/login") =>
    res.redirect(`${baseUrl(req)}${to}${to.includes("?") ? "&" : "?"}error=${encodeURIComponent(message)}`);

  let state;
  try {
    state = jwt.verify(readCookie(req, STATE_COOKIE) ?? "", env.jwtSecret);
  } catch {
    return fail("Sign-in took too long or was started in another browser. Try again.");
  }
  res.clearCookie(STATE_COOKIE, cookieOptions());

  const returnTo = state.linkUserId ? "/settings" : "/login";
  if (state.provider !== provider.name || state.nonce !== req.query.state) {
    return fail("Sign-in couldn't be verified. Try again.", returnTo);
  }
  if (req.query.error || !req.query.code) {
    return fail(`${provider.label} sign-in was cancelled.`, returnTo);
  }

  let profile;
  try {
    profile = await provider.fetchProfile(String(req.query.code), callbackUrl(req, provider.name), provider.client);
  } catch (error) {
    console.error(`${provider.label} sign-in failed:`, error.message);
    return fail(`${provider.label} sign-in didn't work. Try again in a moment.`, returnTo);
  }

  try {
    if (state.linkUserId) {
      const user = await connectProvider(state.linkUserId, provider, profile);
      await refreshUser(user);
      return res.redirect(`${baseUrl(req)}/settings?connected=${provider.name}`);
    }
    const user = await findOrCreateUser(provider, profile);
    const fragment = new URLSearchParams({ token: signToken(user), next: state.next });
    return res.redirect(`${baseUrl(req)}/auth/callback#${fragment}`);
  } catch (error) {
    if (!(error instanceof HttpError)) console.error(error);
    return fail(error instanceof HttpError ? error.message : "Something went wrong. Try again.", returnTo);
  }
}

async function connectProvider(userId, provider, profile) {
  const field = `${provider.name}Id`;
  const owner = await User.findOne({ [field]: profile.id });
  if (owner && owner.id !== userId) {
    throw new HttpError(409, `That ${provider.label} account is already connected to a different account.`);
  }
  const user = await User.findById(userId);
  if (!user) throw new HttpError(401, "This account no longer exists.");
  user[field] = profile.id;
  user.avatarUrl ??= profile.avatarUrl;
  await user.save();
  return user;
}

async function findOrCreateUser(provider, profile) {
  const field = `${provider.name}Id`;
  const existing = await User.findOne({ [field]: profile.id });
  if (existing) return existing;

  if (!profile.email) {
    throw new HttpError(
      400,
      `Your ${provider.label} account has no verified email address, so it can't be used to sign in.`,
    );
  }
  // Emails aren't verified at sign-up, so silently attaching a provider to an
  // existing password account could hand that account to whoever created it.
  // The owner connects the provider from their settings instead.
  if (await User.exists({ email: profile.email.toLowerCase() })) {
    throw new HttpError(
      409,
      `An account with ${profile.email} already exists. Log in with your password, then connect ${provider.label} in Settings.`,
    );
  }

  const name = (profile.name ?? "").trim().slice(0, 60) || profile.email.split("@")[0];
  // The provider only gives us verified addresses (see above), so this one is verified too.
  return User.create({
    name,
    email: profile.email,
    emailVerified: true,
    [field]: profile.id,
    avatarUrl: profile.avatarUrl,
  });
}

/** Disconnects a provider, as long as the account keeps another way to sign in. */
export async function disconnectProvider(req, res) {
  const name = req.params.provider;
  if (!PROVIDERS[name]) throw new HttpError(404, "That sign-in method isn't available.");
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
