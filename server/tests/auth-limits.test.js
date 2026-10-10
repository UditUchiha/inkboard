import assert from "node:assert/strict";
import { after, before, describe, it } from "node:test";
import { startServer } from "./helpers.js";

const { env } = await import("../src/config/env.ts");
const { signToken } = await import("../src/lib/tokens.ts");
const { User } = await import("../src/models/user.model.ts");
const { outbox } = await import("../src/services/email.ts");

// Each kind of request has its own allowance (M9). Everything here comes from one address, as a
// school or an office would, so what's being checked is that one kind doesn't use up another's.
// The server trusts one proxy here, so a request can say which address it's from (X-Forwarded-For),
// as Render's proxy does; requests that don't say come from the tests' own address.
const emailSettings = { ...env.email };
const trustProxy = env.trustProxy;
let app;
before(async () => {
  env.trustProxy = 1;
  app = await startServer();
  Object.assign(env.email, { brevoApiKey: "test-key", from: "inkboard@example.test" });
});
after(() => {
  Object.assign(env.email, emailSettings);
  env.trustProxy = trustProxy;
  return app.stop();
});

const post = (route, body, user) => app.request(route, { method: "POST", body, user });
const login = (email, password) => post("/auth/login", { email, password });
const loginFrom = (address, email, password) =>
  fetch(`${app.url}/api/auth/login`, {
    method: "POST",
    headers: { "Content-Type": "application/json", "X-Forwarded-For": address },
    body: JSON.stringify({ email, password }),
  }).then((response) => response.status);

describe("logging in", () => {
  it("limits wrong guesses at one account, without locking out anyone else on the same network", async () => {
    await User.create({ name: "Target", email: "target@example.test", password: "the-real-password" });
    await User.create({ name: "Other", email: "other@example.test", password: "other-password" });

    for (let attempt = 1; attempt <= 10; attempt += 1) {
      assert.equal((await login("target@example.test", `guess ${attempt}`)).status, 401);
    }
    const blocked = await login("target@example.test", "the-real-password");
    assert.equal(blocked.status, 429, "whoever made the guesses waits, even with the right password");
    assert.equal((await login("TARGET@example.test", "the-real-password")).status, 429, "whatever the case");

    assert.equal((await login("other@example.test", "other-password")).status, 200);
    assert.equal(
      (await post("/auth/register", { name: "New", email: "new@example.test", password: "a-good-password" })).status,
      201,
    );
  });

  it("doesn't let a stranger lock the owner out by guessing wrong from elsewhere (M9)", async () => {
    await User.create({ name: "Owner", email: "owner@example.test", password: "the-owners-password" });
    // Someone keeps the account's allowance used up, from several addresses of their own.
    for (const address of ["203.0.113.1", "203.0.113.2"]) {
      for (let attempt = 1; attempt <= 10; attempt += 1) {
        assert.equal(await loginFrom(address, "owner@example.test", `guess ${attempt}`), 401);
      }
      assert.equal(await loginFrom(address, "owner@example.test", "another guess"), 429);
    }
    // The owner, at home, logs in as usual, and can still get a password wrong a few times.
    assert.equal(await loginFrom("198.51.100.7", "owner@example.test", "a typo"), 401);
    assert.equal(await loginFrom("198.51.100.7", "owner@example.test", "the-owners-password"), 200);
  });

  it("limits one address's wrong guesses across accounts", async () => {
    for (let attempt = 1; attempt <= 30; attempt += 1) {
      assert.equal(await loginFrom("192.0.2.9", `stuffed-${attempt}@example.test`, "password1"), 401);
    }
    assert.equal(await loginFrom("192.0.2.9", "stuffed-31@example.test", "password1"), 429);
  });

  it("doesn't count logins that worked", async () => {
    await User.create({ name: "Busy", email: "busy@example.test", password: "busy-password" });
    for (let count = 0; count < 15; count += 1) {
      assert.equal((await login("busy@example.test", "busy-password")).status, 200);
    }
  });
});

describe("asking for a password reset", () => {
  it("is limited per address, so an inbox can't be flooded, and says the same either way", async () => {
    await User.create({ name: "Inbox", email: "inbox@example.test", password: "inbox-password" });
    const sent = () => outbox.filter((email) => email.to === "inbox@example.test").length;
    const statuses = [];
    for (let attempt = 0; attempt < 5; attempt += 1) {
      statuses.push((await post("/auth/forgot-password", { email: "inbox@example.test" })).status);
    }
    assert.deepEqual(statuses, [200, 200, 200, 429, 429]);
    assert.ok(sent() <= 1, "and at most one mail goes out a minute anyway");

    // Other addresses are unaffected.
    assert.equal((await post("/auth/forgot-password", { email: "someone-else@example.test" })).status, 200);
  });
});

describe("signed-in actions", () => {
  it("are limited per person, not per address", async () => {
    const withPassword = async (name) => {
      const user = await User.create({ name, email: `${name}@example.test`, password: "the-password" });
      return { token: signToken(user) };
    };
    const first = await withPassword("first");
    const second = await withPassword("second");
    const wrong = { currentPassword: "x", newPassword: "a-new-password" };
    for (let attempt = 0; attempt < 10; attempt += 1) {
      assert.equal((await post("/auth/password", wrong, first)).status, 400);
    }
    assert.equal((await post("/auth/password", wrong, first)).status, 429);
    assert.equal((await post("/auth/password", wrong, second)).status, 400);
  });
});
