import assert from "node:assert/strict";
import { after, before, describe, it } from "node:test";
import { startServer } from "./helpers.js";

const { env } = await import("../src/config/env.js");
const { outbox } = await import("../src/services/email.js");
const { User } = await import("../src/models/user.model.js");
const { sendVerificationEmail } = await import("../src/services/account-emails.js");

// Email is off unless it's set up; these tests turn it on (tests never really send).
const emailSettings = { ...env.email };
const turnEmail = (on) => Object.assign(env.email, on ? { brevoApiKey: "test-key", from: "inkboard@example.test" } : emailSettings);

let app;
before(async () => {
  app = await startServer();
  turnEmail(true);
});
after(() => {
  turnEmail(false);
  return app.stop();
});

let counter = 0;
const newEmail = (name) => `${name}-${(counter += 1)}@example.test`;
const post = (path, body, user) => app.request(path, { method: "POST", body, user });

// The newest email sent to `to`, and the secret in its link.
function lastEmailTo(to) {
  const email = outbox.findLast((sent) => sent.to === to);
  return email && { ...email, token: email.text.match(/token=([\w-]+)/)?.[1], link: email.text.match(/https?:\/\/\S+/)?.[0] };
}

// The auth routes allow 30 tries per 15 minutes from one address, so accounts are
// made directly and only the routes under test are called.
async function account(name = "Ana", { password, verified = false } = {}) {
  const email = newEmail(name.toLowerCase());
  const user = await User.create({ name, email, password, emailVerified: verified });
  if (!verified) await sendVerificationEmail(user, app.url);
  return { id: user.id, name, email, token: (await import("../src/lib/tokens.js")).signToken(user) };
}

describe("forgetting a password", () => {
  it("emails a reset link to an account's address, and says the same for unknown ones", async () => {
    const user = await account();
    const before = outbox.length;
    const unknown = await post("/auth/forgot-password", { email: "nobody-here@example.test" });
    assert.equal(unknown.status, 200);
    assert.equal(outbox.length, before, "nothing is sent to an address without an account");

    const known = await post("/auth/forgot-password", { email: user.email.toUpperCase() });
    assert.deepEqual(known.data, unknown.data, "the answer doesn't reveal who has an account");
    const email = lastEmailTo(user.email);
    assert.match(email.subject, /Reset your Inkboard password/);
    assert.match(email.link, /\/reset-password\?token=/);
    assert.equal((await post("/auth/forgot-password", { email: "not an email" })).status, 400);
  });

  it("sets a new password from the link, logs in, and verifies the address", async () => {
    const user = await account("Cy", { password: "the-old-password" });
    await post("/auth/forgot-password", { email: user.email });
    const { token } = lastEmailTo(user.email);

    const tooShort = await post("/auth/reset-password", { token, password: "short" });
    assert.equal(tooShort.status, 400);
    assert.match(tooShort.data.error, /at least 8/);

    const reset = await post("/auth/reset-password", { token, password: "the-new-password" });
    assert.equal(reset.status, 200, "a too-short try doesn't use up the link");
    assert.ok(reset.data.token);
    assert.equal(reset.data.user.emailVerified, true);

    assert.equal((await post("/auth/login", { email: user.email, password: "the-old-password" })).status, 401);
    assert.equal((await post("/auth/login", { email: user.email, password: "the-new-password" })).status, 200);
    assert.equal((await post("/auth/reset-password", { token, password: "another-password" })).status, 400, "the link works once");
  });

  it("lets someone who signed up with Google or GitHub set a password the same way", async () => {
    const email = newEmail("oauth");
    const user = await User.create({ name: "Dee", email, googleId: "g-123", emailVerified: true });
    await post("/auth/forgot-password", { email });
    const reset = await post("/auth/reset-password", { token: lastEmailTo(email).token, password: "now-with-a-password" });
    assert.equal(reset.status, 200);
    assert.equal(reset.data.user.hasPassword, true);
    assert.equal(reset.data.user.id, user.id);
  });

  it("links to the app where the person is using it: an allowed client address, or else the server", async () => {
    const ask = async (origin) => {
      const user = await account("Eve", { verified: true });
      await fetch(`${app.url}/api/auth/forgot-password`, {
        method: "POST",
        headers: { "Content-Type": "application/json", ...(origin ? { Origin: origin } : {}) },
        body: JSON.stringify({ email: user.email }),
      });
      return lastEmailTo(user.email).link;
    };
    const client = env.clientOrigins[0] ?? "http://localhost:5173";
    if (env.clientOrigins.includes(client)) assert.ok((await ask(client)).startsWith(`${client}/reset-password?`));
    assert.ok((await ask("https://evil.example")).startsWith(`${app.url}/reset-password?`), "an unknown origin is ignored");
    assert.ok((await ask(null)).startsWith(`${app.url}/reset-password?`));
  });

  it("doesn't flood an inbox: a second request within a minute sends nothing", async () => {
    const user = await account();
    await post("/auth/forgot-password", { email: user.email });
    const count = outbox.filter((sent) => sent.to === user.email).length;
    assert.equal((await post("/auth/forgot-password", { email: user.email })).status, 200);
    assert.equal(outbox.filter((sent) => sent.to === user.email).length, count);
  });
});
