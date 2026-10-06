import assert from "node:assert/strict";
import { after, before, describe, it } from "node:test";
import { startServer } from "./helpers.js";

// These use the real sign-up and login routes. The auth rate limit allows 30
// attempts per 15 minutes, so this file stays well under that.
let app;
before(async () => {
  app = await startServer();
});
after(() => app.stop());

const register = (body) => app.request("/auth/register", { method: "POST", body });
const login = (body) => app.request("/auth/login", { method: "POST", body });
const valid = { name: "Ada Lovelace", email: "ada@example.test", password: "correct horse" };

describe("sign up", () => {
  it("creates an account and returns a working token", async () => {
    const { status, data } = await register(valid);
    assert.equal(status, 201);
    assert.equal(data.user.name, "Ada Lovelace");
    assert.equal(data.user.email, "ada@example.test");
    assert.equal(data.user.hasPassword, true);
    assert.equal(data.user.password, undefined, "the password never comes back");

    const me = await app.request("/auth/me", { user: { token: data.token } });
    assert.equal(me.status, 200);
    assert.equal(me.data.user.email, "ada@example.test");
  });

  it("normalises the email and refuses a second account for it", async () => {
    const again = await register({ ...valid, email: "  ADA@Example.test " });
    assert.equal(again.status, 409);
  });

  it("explains what is wrong with the details", async () => {
    assert.match((await register({ ...valid, name: "  ", email: "a@b.test" })).data.error, /name/i);
    assert.match((await register({ ...valid, name: "x".repeat(61), email: "b@b.test" })).data.error, /60/);
    assert.match((await register({ ...valid, email: "not-an-email" })).data.error, /email/i);
    assert.match((await register({ ...valid, email: "c@b.test", password: "short" })).data.error, /8 characters/);
    assert.match((await register({ ...valid, email: "d@b.test", password: "p".repeat(73) })).data.error, /72/);
    assert.equal((await register({})).status, 400);
  });
});

describe("log in", () => {
  it("accepts the right password, whatever the email's case", async () => {
    const { status, data } = await login({ email: "ADA@example.test", password: "correct horse" });
    assert.equal(status, 200);
    assert.ok(data.token);
  });

  it("gives the same answer for a wrong password and an unknown email", async () => {
    const wrongPassword = await login({ email: "ada@example.test", password: "wrong password" });
    const unknownEmail = await login({ email: "nobody@example.test", password: "correct horse" });
    assert.equal(wrongPassword.status, 401);
    assert.equal(unknownEmail.status, 401);
    assert.equal(wrongPassword.data.error, unknownEmail.data.error);
  });

  it("asks for both fields", async () => {
    assert.equal((await login({ email: "ada@example.test" })).status, 400);
    assert.equal((await login({ password: "correct horse" })).status, 400);
  });
});

describe("protected routes", () => {
  it("need a valid token", async () => {
    assert.equal((await app.request("/auth/me")).status, 401);
    assert.equal((await app.request("/auth/me", { user: { token: "garbage" } })).status, 401);
    assert.equal((await app.request("/boards")).status, 401);
    assert.equal((await app.request("/notifications")).status, 401);
  });
});

describe("profile and password", () => {
  it("lets people change their name and colour, and checks the colour", async () => {
    const user = await app.signUp("Original");
    const renamed = await app.request("/auth/me", { method: "PATCH", user, body: { name: "  New Name ", color: "#e8590c" } });
    assert.equal(renamed.status, 200);
    assert.equal(renamed.data.user.name, "New Name");
    assert.equal(renamed.data.user.color, "#e8590c");

    assert.equal((await app.request("/auth/me", { method: "PATCH", user, body: { color: "red" } })).status, 400);
    assert.equal((await app.request("/auth/me", { method: "PATCH", user, body: { name: "" } })).status, 400);
    const cleared = await app.request("/auth/me", { method: "PATCH", user, body: { color: null } });
    assert.equal(cleared.data.user.color, null);
  });

  it("changes a password only when the current one is right", async () => {
    const { data } = await register({ name: "Grace", email: "grace@example.test", password: "first password" });
    const user = { token: data.token };

    const wrong = await app.request("/auth/password", { method: "POST", user, body: { currentPassword: "nope", newPassword: "second password" } });
    assert.equal(wrong.status, 400);
    const tooShort = await app.request("/auth/password", { method: "POST", user, body: { currentPassword: "first password", newPassword: "short" } });
    assert.equal(tooShort.status, 400);

    const ok = await app.request("/auth/password", { method: "POST", user, body: { currentPassword: "first password", newPassword: "second password" } });
    assert.equal(ok.status, 200);
    assert.equal((await login({ email: "grace@example.test", password: "first password" })).status, 401);
    assert.equal((await login({ email: "grace@example.test", password: "second password" })).status, 200);
  });
});

describe("social sign-in", () => {
  it("offers no providers until they are configured, and refuses to start one", async () => {
    const providers = await app.request("/auth/providers");
    assert.equal(providers.status, 200);
    assert.deepEqual(providers.data.providers, []);
    const start = await app.request("/auth/oauth/google");
    assert.ok(start.status >= 400 && start.status < 500);
  });
});

describe("health", () => {
  it("reports the database is connected", async () => {
    const response = await fetch(`${app.url}/health`);
    assert.equal(response.status, 200);
    const body = await response.json();
    assert.equal(body.status, "ok");
    assert.equal(body.database, "connected");
  });
});
