import assert from "node:assert/strict";
import { createHash, randomBytes } from "node:crypto";
import http from "node:http";
import { mkdir, mkdtemp, rm, writeFile } from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import { after, before, describe, it } from "node:test";
import jwt from "jsonwebtoken";
import mongoose from "mongoose";
import { eventually, startServer } from "./helpers.js";

const { env } = await import("../src/config/env.ts");
const { createApp } = await import("../src/app.ts");
const { errorHandler } = await import("../src/middleware/error-handler.ts");
const { OAUTH_LINK, OAUTH_LOGIN, OAUTH_STATE, SESSION, signPurposeToken, signToken } =
  await import("../src/lib/tokens.ts");
const { EmailToken } = await import("../src/models/email-token.model.ts");
const { User } = await import("../src/models/user.model.ts");
const { RESERVED_FOR_RESETS, emailsSentToday, outbox } = await import("../src/services/email.ts");
const { sendPasswordResetEmail, sendVerificationEmail } = await import("../src/services/account-emails.ts");

// Email and social sign-in are off unless set up; these tests turn them on (nothing is really sent).
const original = { email: { ...env.email }, oauth: { ...env.oauth }, appUrl: env.appUrl, apiUrl: env.apiUrl };
const realFetch = globalThis.fetch;
const providerRequests = [];
let providerProfile = { id: "google-1", email: "someone@example.test", name: "Some One" };
const jsonResponse = (body) => new Response(JSON.stringify(body), { headers: { "content-type": "application/json" } });

let app;
before(async () => {
  app = await startServer();
  Object.assign(env.email, { brevoApiKey: "test-key", from: "inkboard@example.test" });
  env.oauth.google = { clientId: "google-client", clientSecret: "google-secret" };
  // Stands in for Google; everything else (the tests' own requests to the server) goes through.
  globalThis.fetch = (input, init) => {
    const url = String(input?.url ?? input);
    if (url.startsWith("https://oauth2.googleapis.com/token")) {
      providerRequests.push(init);
      return Promise.resolve(jsonResponse({ access_token: "token" }));
    }
    if (url.startsWith("https://openidconnect.googleapis.com/")) {
      providerRequests.push(init);
      const { id, email, name } = providerProfile;
      return Promise.resolve(jsonResponse({ sub: id, email, email_verified: true, name, picture: null }));
    }
    return realFetch(input, init);
  };
});
after(() => {
  globalThis.fetch = realFetch;
  Object.assign(env.email, original.email);
  Object.assign(env.oauth, original.oauth);
  env.appUrl = original.appUrl;
  env.apiUrl = original.apiUrl;
  return app.stop();
});

let counter = 0;
const newEmail = (name) => `${name}-${(counter += 1)}@example.test`;
const post = (route, body, user) => app.request(route, { method: "POST", body, user });
const tokenFor = (user) => ({ token: signToken(user) });

async function accountWith(fields = {}) {
  const email = newEmail("person");
  const user = await User.create({ name: "Person", email, emailVerified: true, ...fields });
  return { user, email, ...tokenFor(user) };
}

const emailTo = (to, subject) =>
  eventually(() => outbox.findLast((sent) => sent.to === to && subject.test(sent.subject)), {
    message: `an email to ${to}`,
  });
const secretIn = (email) => email.text.match(/token=([\w-]+)/)[1];

const cookieOf = (response, name) =>
  response.headers
    .getSetCookie()
    .map((cookie) => cookie.split(";")[0])
    .find((cookie) => cookie.startsWith(`${name}=`));

const visit = (route, cookie) => fetch(`${app.url}${route}`, { redirect: "manual", headers: cookie ? { cookie } : {} });

// What the app does when it starts a sign-in: keeps a random `bind` in the tab and sends a hash of it.
const newBind = () => randomBytes(24).toString("base64url");
const hashOf = (bind) => createHash("sha256").update(bind).digest("base64url");

// Walks through "Continue with Google" up to the provider's answer; resolves with where the app sends the browser next,
// and the tab's `bind` (a sign-in that connects an account brings its own, in the ticket in `startPath`).
async function signInWithGoogle(
  profile,
  { startPath = "/api/auth/oauth/google", cookies = [], bind = newBind(), sendBind = true } = {},
) {
  providerProfile = profile;
  const path =
    startPath.includes("link=") || !sendBind
      ? startPath
      : `${startPath}${startPath.includes("?") ? "&" : "?"}bind=${hashOf(bind)}`;
  const start = await visit(path, cookies.join("; "));
  const location = new URL(start.headers.get("location"));
  const state = location.searchParams.get("state");
  const callback = await visit(
    `/api/auth/oauth/google/callback?code=a-code&state=${state}`,
    cookieOf(start, "inkboard_oauth"),
  );
  return { start, location, callback, next: callback.headers.get("location"), bind };
}

const fragmentOf = (next) => new URLSearchParams(new URL(next).hash.slice(1));
// The app's last step: hands the code in the redirect, with the tab's `bind`, to the server for a login token.
const exchange = (code, bind) => post("/auth/oauth/exchange", { code, bind });

describe("login tokens", () => {
  it("are only accepted as logins when made for that, and signed with HS256", async () => {
    const { user } = await accountWith();
    const me = (token) => app.request("/auth/me", { user: { token } });
    const common = { sub: user.id, tv: 0 };

    assert.equal((await me(signToken(user))).status, 200);
    const ticket = signPurposeToken(OAUTH_LINK, { sub: user.id, provider: "google", bind: "x" }, 300);
    assert.equal((await me(ticket)).status, 401, "a link ticket is not a login");
    const state = signPurposeToken(OAUTH_STATE, { nonce: "n", provider: "google", linkUserId: user.id }, 300);
    assert.equal((await me(state)).status, 401, "the sign-in state is not a login");
    const oldTicket = jwt.sign({ sub: user.id, purpose: "oauth-link", provider: "google" }, env.jwtSecret, {
      expiresIn: 300,
    });
    assert.equal((await me(oldTicket)).status, 401, "nor is a ticket from before tokens had audiences");
    const hs512 = jwt.sign(common, env.jwtSecret, { algorithm: "HS512", audience: SESSION, expiresIn: 300 });
    assert.equal((await me(hs512)).status, 401, "only HS256");
    const unsigned = jwt.sign(common, "", { algorithm: "none", audience: SESSION });
    assert.equal((await me(unsigned)).status, 401);
    const forged = jwt.sign(common, "another secret", { audience: SESSION, expiresIn: 300 });
    assert.equal((await me(forged)).status, 401);
  });

  it("from before they carried a version or audience keep working until the password changes", async () => {
    const { user } = await accountWith({ password: "the-old-password" });
    // Accounts made earlier have no tokenVersion at all.
    await User.collection.updateOne({ _id: user._id }, { $unset: { tokenVersion: "" } });
    const legacy = jwt.sign({ sub: user.id }, env.jwtSecret, { expiresIn: "7d" });
    assert.equal((await app.request("/auth/me", { user: { token: legacy } })).status, 200);

    const changed = await post(
      "/auth/password",
      { currentPassword: "the-old-password", newPassword: "the-new-password" },
      { token: legacy },
    );
    assert.equal(changed.status, 200);
    assert.equal((await app.request("/auth/me", { user: { token: legacy } })).status, 401, "revoked");
    assert.equal((await app.request("/auth/me", { user: { token: changed.data.token } })).status, 200);
  });
});

describe("ending sessions (M1)", () => {
  it("a password change logs every other session out, sockets included, and keeps the changer in", async () => {
    const { user, email } = await accountWith({ password: "the-old-password" });
    const other = tokenFor(user);
    const socket = await app.connect(other);

    const changed = await post(
      "/auth/password",
      { currentPassword: "the-old-password", newPassword: "newer-password" },
      other,
    );
    assert.equal(changed.status, 200);
    await eventually(() => !socket.socket.connected, { message: "the socket to be closed" });
    assert.equal((await app.request("/auth/me", { user: other })).status, 401);
    await assert.rejects(app.connect(other), /unauthorized/, "a revoked token can't open a socket either");

    const fresh = { token: changed.data.token };
    assert.equal((await app.request("/auth/me", { user: fresh })).status, 200);
    (await app.connect(fresh)).close();
    assert.equal((await post("/auth/login", { email, password: "newer-password" })).status, 200);
  });

  it("a password reset ends every login and returns a new one", async () => {
    const { user, email, token } = await accountWith({ password: "the-old-password" });
    await post("/auth/forgot-password", { email });
    const link = secretIn(await emailTo(email, /Reset your/));
    const reset = await post("/auth/reset-password", { token: link, password: "brand-new-password" });
    assert.equal(reset.status, 200);
    assert.equal((await app.request("/auth/me", { user: { token } })).status, 401);
    assert.equal((await app.request("/auth/me", { user: { token: reset.data.token } })).status, 200);
    assert.equal((await User.findById(user.id)).tokenVersion, 1);
  });

  it("logging out everywhere ends every login, sockets included, and nothing else (M1)", async () => {
    const { user, email } = await accountWith({ password: "a-password" });
    const phone = tokenFor(user);
    const laptop = tokenFor(user);
    const socket = await app.connect(phone);

    assert.equal((await post("/auth/logout-everywhere", {}, laptop)).status, 204);
    await eventually(() => !socket.socket.connected, { message: "the socket to be closed" });
    for (const login of [phone, laptop]) assert.equal((await app.request("/auth/me", { user: login })).status, 401);
    assert.equal((await post("/auth/logout-everywhere", {}, laptop)).status, 401);
    assert.equal((await post("/auth/login", { email, password: "a-password" })).status, 200, "logging in again works");
  });

  it("setting a first password, or connecting a provider, takes a recent login", async () => {
    const { user } = await accountWith({ googleId: "google-first-password" });
    const issuedAt = Math.floor(Date.now() / 1000) - 3600;
    const stale = {
      token: jwt.sign({ sub: user.id, tv: 0, iat: issuedAt }, env.jwtSecret, { audience: SESSION, expiresIn: "7d" }),
    };
    assert.equal((await app.request("/auth/me", { user: stale })).status, 200, "still a good login");

    const refused = await post("/auth/password", { newPassword: "a-first-password" }, stale);
    assert.equal(refused.status, 403);
    assert.match(refused.data.error, /log in again/);
    assert.equal((await post("/auth/oauth/google/link", {}, stale)).status, 403);

    assert.equal((await post("/auth/oauth/google/link", {}, tokenFor(user))).status, 200);
    assert.equal((await post("/auth/password", { newPassword: "a-first-password" }, tokenFor(user))).status, 200);
  });

  it("a request with no login time doesn't count as a recent login", async () => {
    // As if the recent-login check were mounted on a route without requireAuth before it.
    const { assertRecentLogin } = await import("../src/middleware/auth.ts");
    assert.throws(() => assertRecentLogin({}), { status: 403 });
    assert.doesNotThrow(() => assertRecentLogin({ loginIssuedAt: Math.floor(Date.now() / 1000) }));
  });
});

describe("a provider linked before the address was verified (C5)", () => {
  it("can't be connected until the address is verified", async () => {
    const { token } = await accountWith({ emailVerified: false });
    const refused = await post("/auth/oauth/google/link", {}, { token });
    assert.equal(refused.status, 403);
    assert.match(refused.data.error, /Verify your email/);
  });

  it("is disconnected, and logins end, when a password reset proves who owns the address", async () => {
    // What the attacker's side of the attack left behind: their GitHub on an unverified account.
    const { user, email, token } = await accountWith({
      emailVerified: false,
      githubId: "attacker-github",
      password: "the-attackers-password",
    });
    await post("/auth/forgot-password", { email });
    const link = secretIn(await emailTo(email, /Reset your/));
    const reset = await post("/auth/reset-password", { token: link, password: "the-owners-password" });
    assert.equal(reset.status, 200);
    assert.equal(reset.data.user.emailVerified, true);
    assert.deepEqual(reset.data.user.providers, { google: false, github: false });
    assert.equal((await User.findById(user.id).select("+githubId")).githubId, undefined);
    assert.equal((await app.request("/auth/me", { user: { token } })).status, 401, "the attacker's login ended");
  });

  it("can't be set up by having the owner's click verify an account someone else made with their address", async () => {
    // The attacker signs up with the victim's address (and keeps the password to themselves).
    const victim = newEmail("victim");
    const signUp = await post("/auth/register", {
      name: "Attacker",
      email: victim,
      password: "the-attackers-password",
    });
    assert.equal(signUp.status, 201);
    const attacker = { token: signUp.data.token };

    // The victim clicks the link in their inbox. They aren't logged in to that account, so it isn't verified...
    const link = secretIn(await emailTo(victim, /Verify your email/));
    const click = await post("/auth/verify-email", { token: link });
    assert.equal(click.status, 401);
    assert.equal((await User.findOne({ email: victim })).emailVerified, false);
    // ...nor by someone logged in to a different account, which leaves the link working.
    const someoneElse = await accountWith({ emailVerified: false });
    assert.equal((await post("/auth/verify-email", { token: link }, someoneElse)).status, 400);

    // So the attacker still can't connect their Google, even logging in again with the password they chose.
    const again = await post("/auth/login", { email: victim, password: "the-attackers-password" });
    assert.equal((await post("/auth/oauth/google/link", {}, { token: again.data.token })).status, 403);

    // The victim can't sign up, so they reset the password, which proves the address is theirs.
    assert.equal(
      (await post("/auth/register", { name: "Victim", email: victim, password: "victims-password" })).status,
      409,
    );
    await post("/auth/forgot-password", { email: victim });
    const reset = await post("/auth/reset-password", {
      token: secretIn(await emailTo(victim, /Reset your/)),
      password: "the-victims-password",
    });
    assert.equal(reset.status, 200);
    assert.deepEqual(reset.data.user.providers, { google: false, github: false });

    // Every way the attacker had in is gone; "Continue with Google" makes them an account of their own.
    for (const token of [attacker.token, again.data.token]) {
      assert.equal((await app.request("/auth/me", { user: { token } })).status, 401);
    }
    assert.equal((await post("/auth/login", { email: victim, password: "the-attackers-password" })).status, 401);
    const google = await signInWithGoogle({ id: "attacker-google-c5", email: newEmail("attacker"), name: "Attacker" });
    const { token } = (await exchange(fragmentOf(google.next).get("code"), google.bind)).data;
    assert.notEqual((await app.request("/auth/me", { user: { token } })).data.user.email, victim);
  });

  it("is verified by its link for the person logged in to it, who stays logged in", async () => {
    const { user, token } = await accountWith({ emailVerified: false });
    await sendVerificationEmail(user, app.url);
    const link = secretIn(await emailTo(user.email, /Verify your email/));
    const verified = await post("/auth/verify-email", { token: link }, { token });
    assert.equal(verified.status, 200);
    assert.equal(verified.data.user.emailVerified, true);
    assert.equal((await app.request("/auth/me", { user: { token } })).status, 200);
  });
});

describe("connecting Google to an account (M2)", () => {
  // Asks to connect Google and goes through it; resolves with the `connect` note the app gets back, and the `bind` it kept.
  async function connectGoogle(login, profile) {
    const asked = await post("/auth/oauth/google/link", {}, login);
    assert.equal(asked.status, 200);
    const { url, bind } = asked.data;
    const { location, next } = await signInWithGoogle(profile, { startPath: url });
    assert.match(location.href, /^https:\/\/accounts\.google\.com\//);
    const fragment = new URLSearchParams(new URL(next).hash.slice(1));
    assert.equal(new URL(next).pathname, "/settings");
    assert.equal(fragment.get("provider"), "google");
    return { url, bind, connect: fragment.get("connect") };
  }
  const confirm = (body, login) => post("/auth/oauth/google/link/confirm", body, login);

  it("needs no cookie from the app's own requests, so it works when the app is on another site (M10)", async () => {
    const { user, token } = await accountWith();
    const asked = await realFetch(`${app.url}/api/auth/oauth/google/link`, {
      method: "POST",
      headers: { Authorization: `Bearer ${token}` },
    });
    assert.deepEqual(asked.headers.getSetCookie(), [], "nothing a browser would block as third-party");

    const { connect, bind } = await connectGoogle(
      { token },
      { id: "google-linked", email: "x@example.test", name: "X" },
    );
    assert.equal((await User.findById(user.id).select("+googleId")).googleId, undefined, "not until the app confirms");
    const done = await confirm({ connect, bind }, { token });
    assert.equal(done.status, 200);
    assert.equal(done.data.user.providers.google, true);
    assert.equal((await User.findById(user.id).select("+googleId")).googleId, "google-linked");
  });

  it("only connects for the person, and the tab, that asked", async () => {
    const linkMaker = await accountWith();
    const victim = await accountWith();
    // The link-maker sends their URL to the victim, who goes through Google with it.
    const { connect, bind } = await connectGoogle(linkMaker, { id: "google-victim", email: victim.email, name: "V" });

    // The victim's tab is logged in as the victim, and has no `bind` (or someone else's).
    assert.equal((await confirm({ connect }, victim)).status, 403);
    assert.equal((await confirm({ connect, bind }, victim)).status, 403);
    // Even with the link-maker's login planted in the victim's tab, the tab hasn't got the link-maker's `bind`.
    assert.equal((await confirm({ connect, bind: "a-guess" }, linkMaker)).status, 403);
    assert.equal((await confirm({ connect, bind }, {})).status, 401);
    assert.equal((await confirm({ connect: "made-up", bind }, linkMaker)).status, 400);
    for (const { user } of [linkMaker, victim]) {
      assert.equal((await User.findById(user.id).select("+googleId")).googleId, undefined);
    }

    // A ticket from the URL is only good for the provider it was made for.
    const { url } = (await post("/auth/oauth/google/link", {}, linkMaker)).data;
    env.oauth.github = { clientId: "github-client", clientSecret: "github-secret" };
    try {
      const github = await visit(url.replace("/google?", "/github?"));
      assert.match(github.headers.get("location"), /\/settings\?error=link-expired&provider=github$/);
    } finally {
      env.oauth.github = original.oauth.github;
    }
  });

  it("refuses a Google account someone else has connected", async () => {
    await accountWith({ googleId: "google-taken" });
    const { token } = await accountWith();
    const { connect, bind } = await connectGoogle(
      { token },
      { id: "google-taken", email: "t@example.test", name: "T" },
    );
    const refused = await confirm({ connect, bind }, { token });
    assert.equal(refused.status, 409);
    assert.match(refused.data.error, /already connected to a different account/);
  });
});

describe("sign-in providers named in the URL", () => {
  it("only knows Google and GitHub, not names every object has", async () => {
    const { token } = await accountWith({ password: "a-password-here" });
    for (const name of ["constructor", "toString", "__proto__"]) {
      assert.equal((await app.request(`/auth/oauth/${name}`)).status, 404, `start ${name}`);
      assert.equal((await app.request(`/auth/oauth/${name}`, { method: "DELETE", user: { token } })).status, 404);
    }
  });
});

describe("Continue with Google", () => {
  it("creates an account, hands the app a sign-in code (not a login) to exchange, and sends failures as codes", async () => {
    const email = newEmail("fresh");
    const { next, bind } = await signInWithGoogle({ id: "google-fresh", email, name: "Fresh Face" });
    const fragment = fragmentOf(next);
    assert.equal(new URL(next).pathname, "/auth/callback");
    assert.equal(fragment.get("token"), null, "no login token in the URL");
    const loggedIn = await exchange(fragment.get("code"), bind);
    assert.equal(loggedIn.status, 200);
    assert.equal(loggedIn.data.user.email, email);
    assert.equal((await app.request("/auth/me", { user: { token: loggedIn.data.token } })).data.user.email, email);

    // The same address under another Google account: no takeover, and no text of the link's choosing.
    const taken = await signInWithGoogle({ id: "google-other", email, name: "Impostor" });
    assert.match(taken.next, /\/login\?error=email-in-use&provider=google$/);

    // A state that doesn't belong to this browser.
    const start = await visit(`/api/auth/oauth/google?bind=${hashOf(newBind())}`);
    const forged = await visit(
      "/api/auth/oauth/google/callback?code=c&state=made-up",
      cookieOf(start, "inkboard_oauth"),
    );
    assert.match(forged.headers.get("location"), /error=unverified/);
    assert.match(
      (await visit("/api/auth/oauth/google/callback?code=c&state=made-up")).headers.get("location"),
      /error=expired/,
    );
  });

  it("only goes on to a path inside the app, refusing ones a browser would read as another site", async () => {
    const nextAfter = async (next) => {
      const email = newEmail("next");
      const startPath = `/api/auth/oauth/google?next=${encodeURIComponent(next)}`;
      const signedIn = await signInWithGoogle({ id: `google-${email}`, email, name: "N" }, { startPath });
      return fragmentOf(signedIn.next).get("next");
    };
    assert.equal(await nextAfter("/board/abc?x=1"), "/board/abc?x=1");
    for (const next of ["//evil.example/x", "/\\evil.example/x", "/x\\y", "/\t/evil.example", "https://evil.example"]) {
      assert.equal(await nextAfter(next), "/boards", next);
    }
  });

  it("cuts a long name made from the email's first part to fit", async () => {
    const email = `${"n".repeat(80)}@example.test`;
    const { next } = await signInWithGoogle({ id: "google-long", email, name: "" });
    assert.equal(new URL(next).pathname, "/auth/callback");
    assert.equal((await User.findOne({ email })).name.length, 60);
  });

  it("two sign-ins at once make one account, not an error", async () => {
    const email = newEmail("twice");
    const results = await Promise.all([1, 2].map(() => signInWithGoogle({ id: "google-twice", email, name: "Twice" })));
    for (const { next } of results) assert.equal(new URL(next).pathname, "/auth/callback", next);
    assert.equal(await User.countDocuments({ email }), 1);
  });

  it("asks the provider with a time limit, so a hung provider can't hang the sign-in", async () => {
    providerRequests.length = 0;
    await signInWithGoogle({ id: "google-timeout", email: newEmail("timeout"), name: "T" });
    assert.ok(providerRequests.length >= 2);
    assert.ok(providerRequests.every((init) => init.signal instanceof AbortSignal));
  });

  it("calls back to the API's address and then goes to the app's address when they differ (M10)", async () => {
    env.apiUrl = "https://api.example.test";
    env.appUrl = "https://app.example.test";
    try {
      const { location, next } = await signInWithGoogle({
        id: "google-split",
        email: newEmail("split"),
        name: "Split",
      });
      assert.equal(
        location.searchParams.get("redirect_uri"),
        "https://api.example.test/api/auth/oauth/google/callback",
      );
      assert.ok(next.startsWith("https://app.example.test/auth/callback#"), next);
    } finally {
      env.apiUrl = original.apiUrl;
      env.appUrl = original.appUrl;
    }
  });
});

describe("finishing a Google or GitHub sign-in in the tab that started it (login CSRF, C5)", () => {
  // The app's first step for a sign-in is a random `bind` kept in the tab; the redirect at the end carries a
  // code that is only good with it, so a redirect someone else made can't sign a different browser in.
  const signIn = (name) => signInWithGoogle({ id: `google-${name}`, email: newEmail(name), name });

  it("won't start without the tab's bind, which is what ties the end of the sign-in to the browser", async () => {
    for (const startPath of [
      "/api/auth/oauth/google",
      "/api/auth/oauth/google?bind=short",
      "/api/auth/oauth/google?bind[]=x",
    ]) {
      const start = await visit(startPath);
      assert.match(start.headers.get("location"), /\/login\?error=incomplete&provider=google$/, startPath);
      assert.equal(cookieOf(start, "inkboard_oauth"), undefined, "nothing was started");
    }
  });

  it("puts a short-lived code in the redirect, never a login token", async () => {
    const { next, bind } = await signIn("code");
    const fragment = fragmentOf(next);
    assert.deepEqual([...fragment.keys()].sort(), ["code", "next"]);
    // The code isn't a login, anywhere logins are checked...
    assert.equal((await app.request("/auth/me", { user: { token: fragment.get("code") } })).status, 401);
    // ...and lasts about two minutes.
    const claims = jwt.decode(fragment.get("code"));
    assert.equal(claims.aud, OAUTH_LOGIN);
    assert.ok(claims.exp - claims.iat <= 120);
    assert.equal(claims.bind, hashOf(bind), "only a hash of the bind is in it");
    assert.ok(!fragment.get("code").includes(bind));
  });

  it("answers with the login for the tab that holds the bind, once", async () => {
    const { next, bind } = await signIn("once");
    const code = fragmentOf(next).get("code");
    const first = await exchange(code, bind);
    assert.equal(first.status, 200);
    assert.equal((await app.request("/auth/me", { user: { token: first.data.token } })).status, 200);
    const replay = await exchange(code, bind);
    assert.equal(replay.status, 400, "opening the same redirect again");
    assert.equal(replay.data.token, undefined);
  });

  it("refuses a redirect made in another browser: no bind, or the wrong one, is no login", async () => {
    // The attacker signs in to an account of theirs (here, with the victim's address) and sends the victim the redirect.
    const attacker = await signIn("login-csrf");
    const code = fragmentOf(attacker.next).get("code");
    for (const body of [
      { code },
      { code, bind: "" },
      { code, bind: newBind() },
      { code, bind: hashOf(attacker.bind) },
      { code, bind: 42 },
    ]) {
      const refused = await post("/auth/oauth/exchange", body);
      assert.equal(refused.status, 403, JSON.stringify(body));
      assert.equal(refused.data.token, undefined);
    }
    // Only a tab holding the bind can use it, and the wrong guesses didn't use the code up.
    assert.equal((await exchange(code, attacker.bind)).status, 200);
  });

  it("refuses codes that are expired, forged, made for another purpose, or for an account that's gone", async () => {
    const user = await User.create({ name: "Gone", email: newEmail("gone"), emailVerified: true });
    const bind = newBind();
    const claims = () => ({ sub: user.id, bind: hashOf(bind), jti: randomBytes(8).toString("hex") });

    assert.equal((await exchange(signPurposeToken(OAUTH_LOGIN, claims(), -10), bind)).status, 400, "expired");
    assert.equal((await exchange("made-up", bind)).status, 400);
    assert.equal((await exchange(undefined, bind)).status, 400);
    assert.equal((await exchange(signToken(user), bind)).status, 400, "a login isn't a code");
    assert.equal((await exchange(signPurposeToken(OAUTH_STATE, claims(), 60), bind)).status, 400, "nor is a state");
    const forged = jwt.sign(claims(), "not-the-secret", { audience: OAUTH_LOGIN, expiresIn: 60 });
    assert.equal((await exchange(forged, bind)).status, 400);
    const withoutId = { sub: user.id, bind: hashOf(bind) };
    assert.equal(
      (await exchange(signPurposeToken(OAUTH_LOGIN, withoutId, 60), bind)).status,
      400,
      "one that can't be used once",
    );

    const fine = signPurposeToken(OAUTH_LOGIN, claims(), 60);
    await User.deleteOne({ _id: user.id });
    assert.equal((await exchange(fine, bind)).status, 401);
  });

  it("can't be used to sign in as someone else by changing the code's account", async () => {
    const mine = await signIn("mine");
    const other = await accountWith();
    const { aud: _aud, ...claims } = jwt.decode(fragmentOf(mine.next).get("code"));
    const swapped = jwt.sign({ ...claims, sub: other.user.id }, "not-the-secret", { audience: OAUTH_LOGIN });
    assert.equal((await exchange(swapped, mine.bind)).status, 400);
  });
});

describe("headers and files the server sends", () => {
  it("lets profile photos from Google and GitHub through the content security policy (M6)", async () => {
    const csp = (await fetch(`${app.url}/health`)).headers.get("content-security-policy");
    const images = csp.match(/img-src ([^;]+)/)[1].split(" ");
    for (const source of [
      "'self'",
      "data:",
      "blob:",
      "https://*.googleusercontent.com",
      "https://avatars.githubusercontent.com",
    ]) {
      assert.ok(images.includes(source), `img-src has ${source}: ${csp}`);
    }
    assert.ok(!images.includes("*") && !images.includes("https:"));
  });

  it("stays up (200) while the database is away, and says so", async () => {
    Object.defineProperty(mongoose.connection, "readyState", { value: 0, configurable: true });
    try {
      const response = await fetch(`${app.url}/health`);
      assert.equal(response.status, 200);
      assert.deepEqual((({ status, database }) => ({ status, database }))(await response.json()), {
        status: "degraded",
        database: "disconnected",
      });
    } finally {
      delete mongoose.connection.readyState;
    }
    assert.equal((await (await fetch(`${app.url}/health`)).json()).status, "ok");
  });

  it("serves a picture only to its own browser's cache, and to other sites only when the app is elsewhere (L21)", async () => {
    const owner = await app.signUp("Owner");
    const boardId = await app.createBoard(owner);
    const client = await app.connect(owner);
    await client.join(boardId);
    const header = Buffer.concat([
      Buffer.from("89504e470d0a1a0a0000000d49484452", "hex"),
      Buffer.from("0000001000000010", "hex"),
      Buffer.alloc(100, 1),
    ]);
    const { id } = await client.image(boardId, header);
    client.close();

    const response = await fetch(`${app.url}/api/images/${id}`);
    assert.equal(response.status, 200);
    assert.equal(response.headers.get("cache-control"), "private, max-age=86400, immutable");
    assert.equal(response.headers.get("cross-origin-resource-policy"), "cross-origin", "a CLIENT_ORIGIN is allowed");
    await response.arrayBuffer();

    const origins = env.clientOrigins.splice(0);
    try {
      const same = await fetch(`${app.url}/api/images/${id}/small`);
      assert.equal(same.headers.get("cross-origin-resource-policy"), "same-origin");
      await same.arrayBuffer();
    } finally {
      env.clientOrigins.push(...origins);
    }
  });
});

describe("the built app's files", () => {
  let dir;
  let server;
  let base;
  before(async () => {
    // The path has an "assets" folder above the build, which mustn't make every file in it immutable.
    dir = await mkdtemp(path.join(os.tmpdir(), "inkboard-"));
    const dist = path.join(dir, "assets", "dist");
    await mkdir(path.join(dist, "assets"), { recursive: true });
    await writeFile(path.join(dist, "index.html"), "<!doctype html><title>app</title>");
    await writeFile(path.join(dist, "favicon.svg"), "<svg/>");
    await writeFile(path.join(dist, "assets", "app-123.js"), "export {}");
    server = http.createServer(createApp({ clientDist: dist }));
    await new Promise((resolve) => server.listen(0, "127.0.0.1", resolve));
    base = `http://127.0.0.1:${server.address().port}`;
  });
  after(async () => {
    await new Promise((resolve) => server.close(resolve));
    await rm(dir, { recursive: true, force: true });
  });

  it("serves the page for app routes, for GET and HEAD", async () => {
    for (const method of ["GET", "HEAD"]) {
      for (const route of ["/", "/boards", "/board/abc123"]) {
        const response = await fetch(base + route, { method, headers: { accept: "text/html" } });
        assert.equal(response.status, 200, `${method} ${route}`);
        assert.match(response.headers.get("content-type"), /html/);
      }
    }
  });

  it("answers 404, not the page, for files that don't exist", async () => {
    for (const route of ["/assets/gone-123.js", "/robots.txt", "/fonts/x.woff2", "/assets/gone"]) {
      const response = await fetch(base + route, { headers: { accept: "*/*" } });
      assert.equal(response.status, 404, route);
      assert.doesNotMatch(await response.text(), /<title>app<\/title>/, route);
    }
  });

  it("keeps only the build's hashed files for a year", async () => {
    const hashed = await fetch(`${base}/assets/app-123.js`);
    assert.equal(hashed.headers.get("cache-control"), "public, max-age=31536000, immutable");
    const plain = await fetch(`${base}/favicon.svg`);
    assert.equal(plain.status, 200);
    assert.doesNotMatch(plain.headers.get("cache-control") ?? "", /immutable/);
  });
});

describe("errors", () => {
  it("reports a request the server can't read as a 4xx, not a crash (L9)", async () => {
    const response = await fetch(`${app.url}/api/auth/oauth/%E0%A4%A`);
    assert.equal(response.status, 400);
    assert.equal(
      (
        await fetch(`${app.url}/api/auth/login`, {
          method: "POST",
          headers: { "content-type": "application/json", "content-encoding": "nonsense" },
          body: "{}",
        })
      ).status,
      415,
    );
  });

  it("leaves a reply that's already begun alone, and turns duplicate keys into 409 (L9, L10)", () => {
    const failure = new Error("late");
    let passedOn;
    errorHandler(failure, {}, { headersSent: true }, (error) => (passedOn = error));
    assert.equal(passedOn, failure);

    let sent;
    const res = { headersSent: false, status: (code) => ({ json: (body) => (sent = { code, body }) }) };
    errorHandler(
      Object.assign(new Error("E11000 duplicate key { email: 'a@b.test' }"), { code: 11000 }),
      {},
      res,
      null,
    );
    assert.equal(sent.code, 409);
    assert.doesNotMatch(JSON.stringify(sent.body), /a@b\.test/, "no personal details");
  });

  it("two sign-ups with one address at once give a 201 and a 409 (L10)", async () => {
    const email = newEmail("race");
    const body = { name: "Racer", email, password: "correct horse" };
    const statuses = (await Promise.all([post("/auth/register", body), post("/auth/register", body)])).map(
      (response) => response.status,
    );
    assert.deepEqual(statuses.sort(), [201, 409]);
  });
});

describe("account emails", () => {
  it("a send that fails keeps the earlier link and doesn't hold up trying again (L12)", async () => {
    const { user, token } = await accountWith({ emailVerified: false });
    await sendVerificationEmail(user, app.url);
    const first = secretIn(await emailTo(user.email, /Verify your email/));
    // A minute on, with the mail service down.
    await EmailToken.collection.updateMany({ user: user._id }, { $set: { createdAt: new Date(Date.now() - 120_000) } });
    const limit = env.email.dailyLimit;
    env.email.dailyLimit = emailsSentToday();
    try {
      await assert.rejects(sendVerificationEmail(user, app.url), /daily limit/);
    } finally {
      env.email.dailyLimit = limit;
    }
    assert.equal(await EmailToken.countDocuments({ user: user._id }), 1, "the failed link was dropped");
    assert.equal(await sendVerificationEmail(user, app.url), true, "so a retry isn't told to wait");
    assert.equal(
      (await post("/auth/verify-email", { token: first }, { token })).status,
      400,
      "the new link replaced it",
    );
  });

  it("stops sending at the daily limit, keeping a share of it for password resets (M9)", async () => {
    const limit = env.email.dailyLimit;
    const before = emailsSentToday();
    // Room for 10 more today, of which sign-ups may use what's left once the resets' share is set aside.
    env.email.dailyLimit = emailsSentToday() + 10;
    const forSignUps = env.email.dailyLimit - Math.ceil(env.email.dailyLimit * RESERVED_FOR_RESETS);
    try {
      // A flood of sign-ups, each with its verification email.
      let verifications = 0;
      for (;;) {
        const { user } = await accountWith({ emailVerified: false });
        const sent = await sendVerificationEmail(user, app.url).catch((error) => error);
        if (sent instanceof Error) {
          assert.match(sent.message, /daily limit/);
          break;
        }
        verifications += 1;
      }
      assert.equal(emailsSentToday(), Math.max(forSignUps, before));
      assert.equal(verifications, Math.max(forSignUps, before) - before);
      assert.ok(emailsSentToday() < env.email.dailyLimit, "sign-ups stop before the limit");

      // Someone locked out can still get a reset link, until the limit itself.
      const resets = [];
      for (let count = 0; count < 12; count += 1) {
        const { user } = await accountWith();
        resets.push(
          await sendPasswordResetEmail(user, app.url).then(
            () => "sent",
            () => "refused",
          ),
        );
      }
      assert.ok(resets[0] === "sent", "a reset still goes out after sign-ups ran out");
      assert.equal(emailsSentToday(), env.email.dailyLimit);
      assert.equal(resets.at(-1), "refused");
    } finally {
      env.email.dailyLimit = limit;
    }
  });

  it("registering doesn't wait for the mail service, and a forgotten password answers alike for everyone (L13, L15)", async () => {
    const { email } = await accountWith();
    const known = await post("/auth/forgot-password", { email });
    const unknown = await post("/auth/forgot-password", { email: newEmail("nobody") });
    assert.deepEqual(known.data, unknown.data);
    await emailTo(email, /Reset your/);
  });
});

describe("passwords", () => {
  it("a wrong guess takes as long whether the account's hash is the old bcrypt one or there's no account", async () => {
    const bcrypt = (await import("bcryptjs")).default;
    const legacy = await bcrypt.hash("the-old-password", 12);
    await User.collection.insertOne({
      name: "Dormant",
      email: "dormant@example.test",
      password: legacy,
      emailVerified: true,
    });
    const bcryptTime = async () => {
      const started = performance.now();
      await bcrypt.compare("a guess", legacy);
      return performance.now() - started;
    };
    const loginTime = async (email) => {
      const started = performance.now();
      assert.equal((await post("/auth/login", { email, password: "a guess" })).status, 401);
      return performance.now() - started;
    };
    await loginTime(newEmail("warm-up")); // the first failed login times the bcrypt check
    const check = Math.min(await bcryptTime(), await bcryptTime());
    const unknown = Math.min(await loginTime(newEmail("nobody")), await loginTime(newEmail("nobody")));
    const dormant = Math.min(await loginTime("dormant@example.test"), await loginTime("dormant@example.test"));
    assert.ok(unknown >= check * 0.8, `no account: ${unknown.toFixed(0)} ms, a bcrypt check: ${check.toFixed(0)} ms`);
    assert.ok(Math.abs(unknown - dormant) < check * 0.5, `${unknown.toFixed(0)} ms vs ${dormant.toFixed(0)} ms`);
  });

  describe("the wait that hides bcrypt accounts from failed logins", () => {
    // A timer with a made-up clock, a made-up bcrypt check (`measurements`, one per call) and no real waiting.
    async function timerWith(measurements) {
      const { createCheckTimer } = await import("../src/lib/passwords.ts");
      const clock = { ms: 1_000_000 };
      const waits = [];
      let taken = 0;
      const timer = createCheckTimer({
        measure: async () => measurements[Math.min(taken++, measurements.length - 1)],
        now: () => clock.ms,
        sleep: async (ms) => waits.push(ms),
      });
      // A failed login that began now; resolves with how long it was made to wait.
      const failedLogin = async () => {
        const before = waits.length;
        await timer.waitOut(clock.ms);
        return waits.length > before ? waits.at(-1) : 0;
      };
      const settle = () => new Promise((resolve) => setImmediate(resolve));
      return { timer, clock, failedLogin, settle, measured: () => taken };
    }

    it("isn't stuck with a slow measurement taken while the server was busy", async () => {
      const { timer, failedLogin, settle } = await timerWith([1400, 300, 310, 305]);
      assert.equal(await failedLogin(), 1400, "the first one only has that to go on");
      await settle(); // the steadier measurements are taken in the background
      assert.equal(timer.slowestMs(), 300);
      assert.equal(await failedLogin(), 300);
    });

    it("measures again now and then, off the request path, and not on every failed login", async () => {
      const { clock, failedLogin, settle, measured } = await timerWith([300]);
      await failedLogin();
      await settle();
      const afterStart = measured();
      for (let i = 0; i < 20; i += 1) await failedLogin();
      await settle();
      assert.equal(measured(), afterStart, "nothing more to measure yet");
      clock.ms += 6 * 60 * 1000;
      await failedLogin();
      await settle();
      assert.equal(measured(), afterStart + 1);
    });

    it("lets a slow spell pass out of the window and follows the machine getting slower", async () => {
      const { timer, clock, failedLogin, settle } = await timerWith([300, 300, 300, ...Array(20).fill(600)]);
      await failedLogin();
      await settle();
      assert.equal(timer.slowestMs(), 300);
      for (let i = 0; i < 12; i += 1) {
        clock.ms += 6 * 60 * 1000;
        await failedLogin();
        await settle();
      }
      assert.equal(timer.slowestMs(), 600);
    });

    it("stays within what a bcrypt check can reasonably take", async () => {
      const slow = await timerWith([60_000]);
      assert.equal(await slow.failedLogin(), 1500);
      const fast = await timerWith([0.5]);
      assert.equal(await fast.failedLogin(), 100, "a lucky fast measurement can't make dormant accounts stand out");
    });

    it("measures once when the first failed logins arrive together", async () => {
      const { timer, settle, measured } = await timerWith([300]);
      await Promise.all([1, 2, 3].map(() => timer.waitOut(performance.now())));
      assert.ok(measured() >= 1);
      await settle();
      assert.equal(measured(), 3, "one on the path, the other two for steadiness, not one per login");
    });
  });

  it("are stored with scrypt and checked against that (L13)", async () => {
    const { user } = await accountWith({ password: "correct horse battery" });
    const stored = (await User.findById(user.id).select("+password")).password;
    assert.match(stored, /^scrypt\$32768\$8\$1\$/);
    assert.equal(
      await (await User.findById(user.id).select("+password")).verifyPassword("correct horse battery"),
      true,
    );
    assert.equal(
      await (await User.findById(user.id).select("+password")).verifyPassword("correct horse batterz"),
      false,
    );
  });

  it("can be up to 128 characters, counted as characters, not bytes (L20)", async () => {
    const emoji = "🔒".repeat(40); // 160 bytes
    const email = newEmail("emoji");
    const made = await post("/auth/register", { name: "Emoji", email, password: emoji });
    assert.equal(made.status, 201);
    assert.equal((await post("/auth/login", { email, password: emoji })).status, 200);
    const tooLong = await post("/auth/register", { name: "Long", email: newEmail("long"), password: "x".repeat(129) });
    assert.equal(tooLong.status, 400);
    assert.match(tooLong.data.error, /128 characters/);
  });
});
