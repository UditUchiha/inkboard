import assert from "node:assert/strict";
import { after, before, describe, it } from "node:test";
import { eventually, startServer } from "./helpers.js";

const { isEmailAddress } = await import("../src/lib/email-address.js");
const { User } = await import("../src/models/user.model.js");

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

  it("checks an email address in no time, whatever junk it is made of", async () => {
    // This took the old regex ~8 s at 80,000 characters and hours at 2 MB: it backtracked quadratically.
    const junk = ["a@" + ".".repeat(80_000) + "@", "a@" + "a.".repeat(40_000) + "@", "a".repeat(1_500_000)];
    for (const email of junk) {
      const started = performance.now();
      const { status } = await register({ ...valid, email, password: "correct horse" });
      assert.equal(status, 400);
      assert.ok(performance.now() - started < 1000, "answered quickly");
    }
    assert.equal((await register({ ...valid, email: `${"a".repeat(250)}@b.test` })).status, 400, "over 254 characters");
  });

  it("recognises addresses without backtracking", () => {
    for (const email of ["a@b.co", "first.last+tag@sub.example.test", "x@y-z.example"]) {
      assert.equal(isEmailAddress(email), true, email);
    }
    for (const email of ["a@b", "a@.b.c", "a@b..c", "a b@c.test", "a@@b.test", "a@b.c.", `${"a".repeat(250)}@b.test`]) {
      assert.equal(isEmailAddress(email), false, email);
    }
    const started = performance.now();
    assert.equal(isEmailAddress("a@" + ".".repeat(250) + "@"), false);
    assert.equal(isEmailAddress("a@" + "a.".repeat(120) + "@"), false);
    assert.ok(performance.now() - started < 50);
  });

  it("explains what is wrong with the details", async () => {
    assert.match((await register({ ...valid, name: "  ", email: "a@b.test" })).data.error, /name/i);
    assert.match((await register({ ...valid, name: "x".repeat(61), email: "b@b.test" })).data.error, /60/);
    assert.match((await register({ ...valid, email: "not-an-email" })).data.error, /email/i);
    assert.match((await register({ ...valid, email: "c@b.test", password: "short" })).data.error, /8 characters/);
    assert.match((await register({ ...valid, email: "d@b.test", password: "p".repeat(129) })).data.error, /128/);
    assert.equal((await register({})).status, 400);
  });
});

describe("log in", () => {
  it("accepts the right password, whatever the email's case", async () => {
    const { status, data } = await login({ email: "ADA@example.test", password: "correct horse" });
    assert.equal(status, 200);
    assert.ok(data.token);
  });

  it("gives the same answer for a wrong password, an unknown email and an account without a password", async () => {
    await User.create({
      name: "Via Google",
      email: "viagoogle@example.test",
      googleId: "google-1",
      emailVerified: true,
    });
    const wrongPassword = await login({ email: "ada@example.test", password: "wrong password" });
    const unknownEmail = await login({ email: "nobody@example.test", password: "correct horse" });
    const noPassword = await login({ email: "viagoogle@example.test", password: "correct horse" });
    assert.equal(wrongPassword.status, 401);
    assert.equal(unknownEmail.status, 401);
    assert.equal(noPassword.status, 401);
    assert.equal(wrongPassword.data.error, unknownEmail.data.error);
    assert.equal(wrongPassword.data.error, noPassword.data.error);
  });

  it("still accepts a password stored by the older bcrypt hashing, and upgrades it", async () => {
    const bcrypt = (await import("bcryptjs")).default;
    const email = "legacy@example.test";
    await User.collection.insertOne({
      name: "Legacy",
      email,
      password: await bcrypt.hash("old password", 4),
      emailVerified: true,
    });
    assert.equal((await login({ email, password: "wrong one" })).status, 401);
    assert.equal((await login({ email, password: "old password" })).status, 200);
    await eventually(async () => (await User.findOne({ email }).select("+password")).password.startsWith("scrypt$"));
    assert.equal((await login({ email, password: "old password" })).status, 200);
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
    const renamed = await app.request("/auth/me", {
      method: "PATCH",
      user,
      body: { name: "  New Name ", color: "#e8590c" },
    });
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

    const wrong = await app.request("/auth/password", {
      method: "POST",
      user,
      body: { currentPassword: "nope", newPassword: "second password" },
    });
    assert.equal(wrong.status, 400);
    const tooShort = await app.request("/auth/password", {
      method: "POST",
      user,
      body: { currentPassword: "first password", newPassword: "short" },
    });
    assert.equal(tooShort.status, 400);

    const ok = await app.request("/auth/password", {
      method: "POST",
      user,
      body: { currentPassword: "first password", newPassword: "second password" },
    });
    assert.equal(ok.status, 200);
    assert.equal((await app.request("/auth/me", { user })).status, 401, "the old token stops working");
    assert.equal((await app.request("/auth/me", { user: { token: ok.data.token } })).status, 200, "the new one works");
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
