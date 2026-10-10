import { startServer } from "./helpers.js"; // first: it sets up the environment
import assert from "node:assert/strict";
import { createHash, randomBytes } from "node:crypto";
import { after, before, describe, it } from "node:test";

const { env } = await import("../src/config/env.js");
const { signToken } = await import("../src/lib/tokens.js");
const { User } = await import("../src/models/user.model.js");

// "Continue with Google" has its own tests (auth-security.test.js). GitHub answers differently: it
// takes a second request for the addresses, and an address only counts when it is verified.
const original = { ...env.oauth };
const realFetch = globalThis.fetch;
const jsonResponse = (body, status = 200) =>
  new Response(JSON.stringify(body), { status, headers: { "content-type": "application/json" } });
let github;
let signedIn;

let app;
before(async () => {
  app = await startServer();
  env.oauth.github = { clientId: "github-client", clientSecret: "github-secret" };
  // Stands in for GitHub; the tests' own requests to the server go through.
  globalThis.fetch = (input, init) => {
    const url = String(input?.url ?? input);
    if (url === "https://github.com/login/oauth/access_token") return Promise.resolve(jsonResponse(github.token));
    if (url === "https://api.github.com/user") return Promise.resolve(jsonResponse(github.profile));
    if (url === "https://api.github.com/user/emails") return Promise.resolve(jsonResponse(github.emails));
    return realFetch(input, init);
  };
});
after(() => {
  globalThis.fetch = realFetch;
  Object.assign(env.oauth, original);
  return app.stop();
});

let counter = 0;
const newEmail = (name) => `${name}-${(counter += 1)}@example.test`;

const cookieOf = (response, name) =>
  response.headers
    .getSetCookie()
    .map((cookie) => cookie.split(";")[0])
    .find((cookie) => cookie.startsWith(`${name}=`));
const visit = (route, cookie) => fetch(`${app.url}${route}`, { redirect: "manual", headers: cookie ? { cookie } : {} });

// What the app does when it starts a sign-in: a random `bind` kept in the tab, of which only a hash is sent.
const bindHash = (bind) => createHash("sha256").update(bind).digest("base64url");

// What GitHub says about a person, then walks "Continue with GitHub" to the provider's answer and
// resolves with where the app sends the browser next. `signedIn` is set to what the app's last step,
// trading the sign-in code for a login (POST /auth/oauth/exchange), answers.
async function finish(
  { id = 1, name = "Octo Cat", emails, token = { access_token: "t" } },
  { startPath, cookies = [], bind = randomBytes(24).toString("base64url") } = {},
) {
  github = { token, profile: { id, name, login: "octocat", avatar_url: null }, emails };
  const path = startPath ?? `/api/auth/oauth/github?bind=${bindHash(bind)}`;
  const start = await visit(path, cookies.join("; "));
  const state = new URL(start.headers.get("location")).searchParams.get("state");
  const callback = await visit(
    `/api/auth/oauth/github/callback?code=a-code&state=${state}`,
    cookieOf(start, "inkboard_oauth"),
  );
  const next = callback.headers.get("location");
  const code = new URLSearchParams(new URL(next).hash.slice(1)).get("code");
  signedIn = code ? await app.request("/auth/oauth/exchange", { method: "POST", body: { code, bind } }) : null;
  return next;
}

describe("Continue with GitHub", () => {
  it("uses the primary verified address, and ignores one GitHub hasn't verified", async () => {
    const primary = newEmail("primary");
    const next = await finish({
      id: 101,
      emails: [
        { email: newEmail("unverified"), primary: true, verified: false },
        { email: newEmail("other"), primary: false, verified: true },
        { email: primary, primary: true, verified: true },
      ],
    });
    assert.equal(new URL(next).pathname, "/auth/callback");
    const user = await User.findOne({ email: primary }).select("+githubId");
    assert.equal(user.githubId, "101");
    assert.equal(user.emailVerified, true);
    assert.equal(signedIn.status, 200, "the app trades the code in the redirect for a login");
    assert.equal(signedIn.data.user.email, primary);
    assert.ok(signedIn.data.token);
  });

  it("falls back to any verified address when the primary one isn't", async () => {
    const verified = newEmail("secondary");
    await finish({
      id: 102,
      emails: [
        { email: newEmail("primary-unverified"), primary: true, verified: false },
        { email: verified, primary: false, verified: true },
      ],
    });
    assert.ok(await User.exists({ email: verified }));
  });

  it("signs the same GitHub account in again without making another", async () => {
    const email = newEmail("again");
    const emails = [{ email, primary: true, verified: true }];
    await finish({ id: 103, emails });
    const first = signedIn;
    const next = await finish({ id: 103, emails: [] });
    assert.equal(new URL(next).pathname, "/auth/callback");
    assert.equal(await User.countDocuments({ email }), 1);
    assert.equal(signedIn.status, 200);
    assert.equal(signedIn.data.user.id, first.data.user.id, "the same account");
  });

  it("answers with codes when there's no verified address, the address is taken, or GitHub refuses", async () => {
    assert.match(
      await finish({ id: 104, emails: [{ email: newEmail("nope"), primary: true, verified: false }] }),
      /\/login\?error=no-email&provider=github$/,
    );

    const taken = newEmail("taken");
    await User.create({ name: "Taken", email: taken, emailVerified: true });
    assert.match(
      await finish({ id: 105, emails: [{ email: taken, primary: true, verified: true }] }),
      /\/login\?error=email-in-use&provider=github$/,
    );

    assert.match(
      await finish({ id: 106, emails: [], token: { error: "bad_verification_code" } }),
      /\/login\?error=provider-failed&provider=github$/,
    );
  });

  it("is cancelled when GitHub sends back an error instead of a code", async () => {
    const start = await visit(`/api/auth/oauth/github?bind=${bindHash(randomBytes(24).toString("base64url"))}`);
    const state = new URL(start.headers.get("location")).searchParams.get("state");
    const callback = await visit(
      `/api/auth/oauth/github/callback?error=access_denied&state=${state}`,
      cookieOf(start, "inkboard_oauth"),
    );
    assert.match(callback.headers.get("location"), /\/login\?error=cancelled&provider=github$/);
  });
});

describe("connecting GitHub to an account", () => {
  // Goes through GitHub from Settings, and confirms what comes back the way the app does (see auth-security.test.js).
  const connect = async (user, profile) => {
    const login = { token: signToken(user) };
    const asked = await app.request("/auth/oauth/github/link", { method: "POST", user: login });
    assert.equal(asked.status, 200);
    const { url, bind } = asked.data;
    const next = await finish(profile, { startPath: url });
    const connect = new URLSearchParams(new URL(next).hash.slice(1)).get("connect");
    return app.request("/auth/oauth/github/link/confirm", { method: "POST", user: login, body: { connect, bind } });
  };

  it("attaches the GitHub account, whatever address it has", async () => {
    const user = await User.create({ name: "Linker", email: newEmail("linker"), emailVerified: true });
    const done = await connect(user, {
      id: 201,
      emails: [{ email: newEmail("elsewhere"), primary: true, verified: true }],
    });
    assert.equal(done.status, 200);
    assert.equal(done.data.user.providers.github, true);
    assert.equal((await User.findById(user.id).select("+githubId")).githubId, "201");
  });

  it("refuses a GitHub account another person already uses", async () => {
    const first = await User.create({ name: "First", email: newEmail("first"), emailVerified: true, githubId: "202" });
    const second = await User.create({ name: "Second", email: newEmail("second"), emailVerified: true });
    const refused = await connect(second, { id: 202, emails: [] });
    assert.equal(refused.status, 409);
    assert.match(refused.data.error, /already connected to a different account/);
    assert.equal((await User.findById(second.id).select("+githubId")).githubId, undefined);
    assert.equal((await User.findById(first.id).select("+githubId")).githubId, "202");
  });
});
