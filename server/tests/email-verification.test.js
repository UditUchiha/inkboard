import assert from "node:assert/strict";
import { after, before, describe, it } from "node:test";
import mongoose from "mongoose";
import { eventually, startServer } from "./helpers.js";

const { env } = await import("../src/config/env.ts");
const { outbox } = await import("../src/services/email.js");
const { EmailToken } = await import("../src/models/email-token.model.ts");
const { User } = await import("../src/models/user.model.ts");
const { sendVerificationEmail, verifyAccountsMadeByProviders } = await import("../src/services/account-emails.js");

// Email is off unless it's set up; these tests turn it on (tests never really send).
const emailSettings = { ...env.email };
const turnEmail = (on) =>
  Object.assign(env.email, on ? { brevoApiKey: "test-key", from: "inkboard@example.test" } : emailSettings);

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
  return (
    email && { ...email, token: email.text.match(/token=([\w-]+)/)?.[1], link: email.text.match(/https?:\/\/\S+/)?.[0] }
  );
}

// Mail goes out after the response (so how long a request takes doesn't depend on the mail service), so wait for it.
const emailTo = (to, subject) =>
  eventually(() => lastEmailTo(to)?.subject.match(subject) && lastEmailTo(to), { message: `an email to ${to}` });

// The auth routes allow 30 tries per 15 minutes from one address, so accounts are
// made directly and only the routes under test are called.
async function account(name = "Ana", { password, verified = false } = {}) {
  const email = newEmail(name.toLowerCase());
  const user = await User.create({ name, email, password, emailVerified: verified });
  if (!verified) await sendVerificationEmail(user, app.url);
  return { id: user.id, name, email, token: (await import("../src/lib/tokens.ts")).signToken(user) };
}

// Makes the last link sent look older, as if the resend wait had passed.
// (Through the driver: Mongoose won't change createdAt.)
const ageLinks = (userId) =>
  EmailToken.collection.updateMany(
    { user: new mongoose.Types.ObjectId(userId) },
    { $set: { createdAt: new Date(Date.now() - 5 * 60 * 1000) } },
  );

describe("verifying an email address", () => {
  it("emails a link at sign-up, and the account works before it's clicked", async () => {
    const address = newEmail("signup");
    const { status, data } = await post("/auth/register", { name: "Ana", email: address, password: "a-good-password" });
    assert.equal(status, 201);
    const user = { ...data.user, token: data.token, email: address };
    assert.equal(user.emailVerified, false);
    const email = await emailTo(user.email, /Verify your email/);
    assert.match(email.subject, /Verify your email/);
    assert.match(email.link, /\/verify-email\?token=[\w-]{40,}&email=/);
    assert.match(email.html, /Verify my email/);
    assert.match(email.text, /asked to log in/, "says what the link will ask for");
    assert.equal((await app.request("/boards", { user })).status, 200, "boards work straight away");
  });

  it("links to Render's own address when APP_URL isn't set, not to the Host header, and to APP_URL when it is", async () => {
    const saved = { appUrl: env.appUrl, renderUrl: env.renderUrl };
    try {
      const signUp = async (headers) => {
        const address = newEmail("links");
        const response = await fetch(`${app.url}/api/auth/register`, {
          method: "POST",
          headers: { "Content-Type": "application/json", ...headers },
          body: JSON.stringify({ name: "Ana", email: address, password: "a-good-password" }),
        });
        assert.equal(response.status, 201);
        return (await emailTo(address, /Verify your email/)).link;
      };
      env.renderUrl = "https://inkboard.onrender.com";
      assert.match(
        await signUp({ Origin: "http://localhost:5173" }),
        /^https:\/\/inkboard\.onrender\.com\/verify-email\?/,
      );
      env.appUrl = "https://ink.example.test";
      assert.match(await signUp({}), /^https:\/\/ink\.example\.test\/verify-email\?/);
    } finally {
      Object.assign(env, saved);
    }
  });

  it("verifies with the link, which works once, for the person logged in to the account (C5)", async () => {
    const user = await account();
    const { token } = lastEmailTo(user.email);
    assert.equal((await post("/auth/verify-email", { token })).status, 401, "not logged in: the link is kept");
    const verified = await post("/auth/verify-email", { token }, user);
    assert.equal(verified.status, 200);
    assert.equal(verified.data.email, user.email);
    assert.equal(verified.data.user.emailVerified, true);
    assert.equal((await app.request("/auth/me", { user })).data.user.emailVerified, true);

    const again = await post("/auth/verify-email", { token }, user);
    assert.equal(again.status, 400);
    assert.match(again.data.error, /expired, was already used/);
  });

  it("refuses made-up, malformed and expired links", async () => {
    const user = await account();
    for (const token of ["x".repeat(43), "short", { $ne: null }]) {
      assert.equal((await post("/auth/verify-email", { token }, user)).status, 400);
    }
    const { token } = lastEmailTo(user.email);
    await EmailToken.updateMany({}, { $set: { expiresAt: new Date(Date.now() - 1000) } });
    assert.equal((await post("/auth/verify-email", { token }, user)).status, 400);
  });

  it("keeps only a hash of each link's secret", async () => {
    const user = await account();
    const { token } = lastEmailTo(user.email);
    const stored = await EmailToken.findOne({ user: user.id }).lean();
    assert.notEqual(stored.hash, token);
    assert.equal(stored.hash.length, 64);
  });

  it("sends a new link on request, but not more than once a minute, and not once verified", async () => {
    const user = await account();
    const first = lastEmailTo(user.email).token;
    const tooSoon = await post("/auth/verify-email/resend", {}, user);
    assert.equal(tooSoon.status, 429);
    assert.match(tooSoon.data.error, /spam folder/);

    await ageLinks(user.id);
    assert.equal((await post("/auth/verify-email/resend", {}, user)).status, 200);
    const second = lastEmailTo(user.email).token;
    assert.notEqual(second, first);
    assert.equal((await post("/auth/verify-email", { token: first }, user)).status, 400, "the old link stops working");
    assert.equal((await post("/auth/verify-email", { token: second }, user)).status, 200);

    await ageLinks(user.id);
    assert.equal((await post("/auth/verify-email/resend", {}, user)).status, 400);
    assert.equal((await post("/auth/verify-email/resend", {})).status, 401);
  });

  it("only lets people invite an address once its owner has verified it", async () => {
    const owner = await app.signUp("Owner");
    const boardId = await app.createBoard(owner);
    const invitee = await account("Bea");
    const invite = () => post(`/boards/${boardId}/collaborators`, { email: invitee.email }, owner);

    const refused = await invite();
    assert.equal(refused.status, 409);
    assert.match(refused.data.error, /hasn't verified their email/);

    await post("/auth/verify-email", { token: lastEmailTo(invitee.email).token }, invitee);
    assert.equal((await invite()).status, 201);
  });
});

describe("accounts from before email verification", () => {
  it("count as verified when made through Google or GitHub, and not when made with a password", async () => {
    const viaGoogle = newEmail("google");
    const withPassword = newEmail("password");
    await User.collection.insertMany([
      { name: "G", email: viaGoogle, googleId: "old-google-1" },
      { name: "P", email: withPassword, password: "$2a$12$abcdefghijklmnopqrstuv" },
    ]);
    assert.ok((await verifyAccountsMadeByProviders()) >= 1);
    assert.equal((await User.findOne({ email: viaGoogle })).emailVerified, true);
    assert.equal((await User.findOne({ email: withPassword })).emailVerified, false);
  });

  it("is a one-time migration: a later start doesn't scan the accounts again", async () => {
    const late = newEmail("late");
    await User.collection.insertOne({ name: "L", email: late, googleId: "old-google-2" });
    assert.equal(await verifyAccountsMadeByProviders(), 0);
    assert.equal((await User.findOne({ email: late })).emailVerified, false);
  });
});

describe("while email isn't set up", () => {
  before(() => turnEmail(false));
  after(() => turnEmail(true));

  it("switches verification and password reset off, and invites work as before", async () => {
    assert.equal((await app.request("/auth/providers")).data.email, false);

    const sent = outbox.length;
    const address = newEmail("noemail");
    const signedUp = await post("/auth/register", { name: "Noa", email: address, password: "a-good-password" });
    assert.equal(signedUp.status, 201);
    assert.equal(outbox.length, sent, "no verification email");

    const owner = await app.signUp("Owner");
    const boardId = await app.createBoard(owner);
    assert.equal((await post(`/boards/${boardId}/collaborators`, { email: address }, owner)).status, 201);

    const user = { token: signedUp.data.token };
    assert.equal((await post("/auth/verify-email/resend", {}, user)).status, 503);
    assert.equal((await post("/auth/forgot-password", { email: address })).status, 503);
  });

  it("says so when it's on", async () => {
    turnEmail(true);
    assert.equal((await app.request("/auth/providers")).data.email, true);
    turnEmail(false);
  });
});
