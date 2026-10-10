import assert from "node:assert/strict";
import { createHash } from "node:crypto";
import { afterEach, beforeEach, describe, it } from "node:test";
import { api, setAuthToken, setUnauthorizedHandler } from "../src/lib/api.ts";
import { formColor } from "../src/lib/profileColor.ts";
import { logoutPlan, tokenUserId } from "../src/lib/session.ts";
import { completeSignIn, hashBind, startSignIn } from "../src/lib/signIn.ts";
import {
  isProvider,
  loginPathFor,
  loginWithError,
  providerLabel,
  safeNext,
  signInErrorMessage,
} from "../src/lib/signInErrors.ts";
import { verifyView } from "../src/lib/verifyLink.ts";

const realFetch = globalThis.fetch;
afterEach(() => {
  globalThis.fetch = realFetch;
  setAuthToken(null);
  setUnauthorizedHandler(() => {});
});

const reply = (status, body) => Promise.resolve(new Response(JSON.stringify(body), { status }));

describe("a refused login (L30)", () => {
  it("logs out when the login that was refused is still the current one", async () => {
    let loggedOut = 0;
    setUnauthorizedHandler(() => (loggedOut += 1));
    setAuthToken("current");
    globalThis.fetch = () => reply(401, { error: "Your session has expired." });
    await assert.rejects(api.me(), { status: 401 });
    assert.equal(loggedOut, 1);
  });

  it("doesn't log out a newer login when a late answer to an older request is a 401", async () => {
    let loggedOut = 0;
    setUnauthorizedHandler(() => (loggedOut += 1));
    setAuthToken("old");
    let answer;
    globalThis.fetch = (url, init) => {
      assert.equal(init.headers.Authorization, "Bearer old");
      return new Promise((resolve) => (answer = () => resolve(new Response("{}", { status: 401 }))));
    };
    const pending = api.me();
    setAuthToken("new"); // logged in again (here or in another tab) while the request was out
    answer();
    await assert.rejects(pending, { status: 401 });
    assert.equal(loggedOut, 0);
  });

  it("doesn't treat a wrong password at the login form as an expired session", async () => {
    let loggedOut = 0;
    setUnauthorizedHandler(() => (loggedOut += 1));
    globalThis.fetch = () => reply(401, { error: "That email and password don't match an account." });
    await assert.rejects(api.login({ email: "a@b.test", password: "x" }), { status: 401 });
    assert.equal(loggedOut, 0);
  });
});

describe("connecting a provider", () => {
  it("needs no cookie, so it works when the API is on another site, and hands back the tab's bind (M2, M10)", async () => {
    const calls = [];
    globalThis.fetch = (url, init) => {
      calls.push({ url, init });
      return reply(200, { url: "/api/auth/oauth/google?link=x", bind: "b" });
    };
    setAuthToken("current");
    assert.deepEqual(await api.linkProvider("google"), { url: "/api/auth/oauth/google?link=x", bind: "b" });
    await api.confirmProviderLink("google", { connect: "note", bind: "b" });
    assert.equal(calls[0].init.credentials, undefined);
    assert.match(calls[1].url, /\/api\/auth\/oauth\/google\/link\/confirm$/);
    assert.deepEqual(JSON.parse(calls[1].init.body), { connect: "note", bind: "b" });
    assert.equal(calls[1].init.headers.Authorization, "Bearer current");
  });
});

describe("where sign-in goes next", () => {
  it("only follows paths inside the app (open redirects)", () => {
    assert.equal(safeNext("/board/abc?x=1#y"), "/board/abc?x=1#y");
    for (const value of [
      "//evil.example/x",
      "/\\evil.example/x",
      "/x\\y",
      "/\t/evil.example",
      "/\n/evil.example",
      "https://evil.example",
      "",
      null,
      undefined,
      42,
    ]) {
      assert.equal(safeNext(value), "/boards", JSON.stringify(value));
    }
  });

  it("keeps where the person was headed when sign-in fails (M7)", () => {
    assert.equal(loginWithError("incomplete", "/board/abc?x=1"), "/login?error=incomplete&next=%2Fboard%2Fabc%3Fx%3D1");
    assert.equal(loginWithError("incomplete", "/boards"), "/login?error=incomplete");
  });
});

describe("sign-in errors come as codes (L32)", () => {
  it("turn into our own messages, and ignore text a link brings", () => {
    assert.equal(signInErrorMessage("cancelled", "google"), "Google sign-in was cancelled.");
    assert.match(signInErrorMessage("email-in-use", "github"), /connect GitHub in Settings/);
    const forged = "Your account is locked. Call 555-0100 or log in at evil.example";
    assert.equal(signInErrorMessage(forged, "google"), "Something went wrong. Try again.");
    assert.equal(signInErrorMessage("constructor", "google"), "Something went wrong. Try again.");
    assert.equal(providerLabel("evil.example"), "your account");
  });

  it("only know the providers we offer", () => {
    assert.equal(isProvider("google"), true);
    assert.equal(isProvider("github"), true);
    assert.equal(isProvider("constructor"), false);
    assert.equal(isProvider(null), false);
  });
});

const loginFor = (sub) => `h.${Buffer.from(JSON.stringify({ sub })).toString("base64url")}.s`;

describe("which login a tab keeps when it logs out (L30)", () => {
  it("reads the account out of a token, without trusting it", () => {
    assert.equal(tokenUserId(loginFor("ana")), "ana");
    const numeric = `h.${Buffer.from('{"sub":5}').toString("base64url")}.s`;
    for (const bad of ["", "abc", "a.b.c", "a..c", null, undefined, 7, numeric]) {
      assert.equal(tokenUserId(bad), null, String(bad));
    }
  });

  it("always logs the tab out when the person chose to, and never adopts another login", () => {
    const own = loginFor("ana");
    for (const stored of [null, own, "newer-login", `${own}2`, loginFor("ben")]) {
      assert.equal(logoutPlan({ own, stored, explicit: true }).adopt, null, String(stored));
    }
  });

  it("follows a newer login for the same account when the server refused the token, but not another account's", () => {
    const own = loginFor("ana");
    const newer = `${own}2`;
    assert.deepEqual(logoutPlan({ own, stored: newer, explicit: false }), { adopt: newer, clearStored: false });
    assert.deepEqual(logoutPlan({ own, stored: loginFor("ben"), explicit: false }), {
      adopt: null,
      clearStored: false,
    });
    assert.deepEqual(logoutPlan({ own, stored: "not-a-token", explicit: false }), { adopt: null, clearStored: false });
  });

  it("only removes the stored login when it's the tab's own (or there is none)", () => {
    const own = loginFor("ana");
    assert.equal(logoutPlan({ own, stored: own, explicit: true }).clearStored, true);
    assert.equal(logoutPlan({ own, stored: null, explicit: false }).clearStored, true);
    assert.equal(logoutPlan({ own, stored: loginFor("ben"), explicit: true }).clearStored, false);
    assert.equal(logoutPlan({ own, stored: `${own}2`, explicit: true }).clearStored, false);
  });
});

describe("finishing a Google or GitHub sign-in in the tab that started it (login CSRF, C5)", () => {
  const storage = new Map();
  beforeEach(() => {
    storage.clear();
    globalThis.sessionStorage = {
      getItem: (key) => storage.get(key) ?? null,
      setItem: (key, value) => storage.set(key, String(value)),
      removeItem: (key) => storage.delete(key),
    };
  });
  const session = { token: "login", user: { id: "u" } };

  it("sends a hash of a bind kept in the tab, which is what the server hashes the same way", async () => {
    const hash = await startSignIn();
    const bind = [...storage.values()][0];
    assert.ok(bind.length >= 32);
    assert.equal(hash, createHash("sha256").update(bind).digest("base64url"));
    assert.equal(await hashBind("abc"), createHash("sha256").update("abc").digest("base64url"));
    assert.match(hash, /^[A-Za-z0-9_-]{43}$/);
    assert.notEqual(await startSignIn(), hash, "a new one each time");
  });

  it("can't start when the tab can't keep a bind", async () => {
    globalThis.sessionStorage = {
      setItem() {
        throw new Error("blocked");
      },
    };
    assert.equal(await startSignIn(), null);
  });

  it("signs nobody in from a redirect this tab didn't start: no bind, no exchange", async () => {
    let asked = 0;
    const exchange = async () => (asked += 1);
    // An attacker's link: a valid code, but this tab never made a bind.
    assert.deepEqual(await completeSignIn({ code: "attackers-code", exchange }), { outcome: "incomplete" });
    assert.equal(asked, 0, "the code isn't even sent anywhere");
    assert.deepEqual(await completeSignIn({ code: null, bind: "mine", exchange }), { outcome: "incomplete" });
    assert.equal(asked, 0);
  });

  it("trades the code and the tab's bind for the login, and forgets the bind", async () => {
    await startSignIn();
    const bind = [...storage.values()][0];
    const calls = [];
    const result = await completeSignIn({
      code: "a-code",
      exchange: async (input) => (calls.push(input), session),
    });
    assert.deepEqual(result, { outcome: "signed-in", session });
    assert.deepEqual(calls, [{ code: "a-code", bind }]);
    assert.equal(storage.size, 0, "a bind is used once");
    assert.deepEqual(await completeSignIn({ code: "a-code", exchange: async () => session }), {
      outcome: "incomplete",
    });
  });

  it("goes back to the log in page when the server refuses, and keeps the bind to retry when it can't be reached", async () => {
    await startSignIn();
    const refuse = async () => Promise.reject(Object.assign(new Error("no"), { status: 403 }));
    const unreachable = async () => Promise.reject(Object.assign(new Error("offline"), { status: 0 }));
    assert.deepEqual(await completeSignIn({ code: "c", exchange: unreachable }), { outcome: "offline" });
    assert.equal(storage.size, 1, "still there for the retry");
    assert.deepEqual(await completeSignIn({ code: "c", exchange: refuse }), { outcome: "incomplete" });
    assert.equal(storage.size, 0);
  });

  it("is asked of the server as a plain request that needs no cookie", async () => {
    const calls = [];
    globalThis.fetch = (url, init) => {
      calls.push({ url, init });
      return reply(200, session);
    };
    assert.deepEqual(await api.exchangeOAuthCode({ code: "c", bind: "b" }), session);
    assert.match(calls[0].url, /\/api\/auth\/oauth\/exchange$/);
    assert.equal(calls[0].init.method, "POST");
    assert.deepEqual(JSON.parse(calls[0].init.body), { code: "c", bind: "b" });
    assert.equal(calls[0].init.credentials, undefined);
  });
});

describe("the page behind a verification link", () => {
  const ana = { email: "ana@example.test" };

  it("waits for the account, and says when it can't be reached instead of asking to log in", () => {
    assert.equal(verifyView({ status: "loading", user: null }), "loading");
    assert.equal(verifyView({ status: "offline", user: null }), "offline");
    assert.equal(verifyView({ status: "anonymous", user: null }), "login");
  });

  it("confirms for the account the link names, whatever the case, or when it doesn't say", () => {
    assert.equal(verifyView({ status: "authenticated", user: ana, linkEmail: "ANA@example.test" }), "confirm");
    assert.equal(verifyView({ status: "authenticated", user: ana, linkEmail: null }), "confirm");
  });

  it("offers to switch when another account is logged in (C5)", () => {
    assert.equal(verifyView({ status: "authenticated", user: ana, linkEmail: "ben@example.test" }), "switch");
  });
});

describe("a login that runs out on the way back from connecting a provider", () => {
  it("keeps the fragment when it sends the person to log in, and follows it back", () => {
    const path = loginPathFor({ pathname: "/settings", search: "", hash: "#connect=abc.def&provider=google" });
    const next = new URL(path, "http://app.test").searchParams.get("next");
    assert.equal(next, "/settings#connect=abc.def&provider=google");
    assert.equal(safeNext(next), next, "and the log in page follows it");
    assert.equal(loginPathFor({ pathname: "/board/abc", search: "?x=1" }), "/login?next=%2Fboard%2Fabc%3Fx%3D1");
  });
});

describe("the color the profile form starts on", () => {
  it("moves only the colors that were replaced to their replacement", () => {
    assert.equal(formColor("#e8590c"), "#c2410c");
    assert.equal(formColor("#E8590C"), "#c2410c");
    assert.equal(formColor("#2f9e44"), "#237a35");
    assert.equal(formColor("#0c8599"), "#0b7285");
    assert.equal(formColor("#f08c00"), "#946200");
  });

  it("keeps any other color as it is, so saving the name doesn't change it", () => {
    assert.equal(formColor("#ffff00"), "#ffff00", "a light custom color isn't darkened into one nobody chose");
    assert.equal(formColor("#c2410c"), "#c2410c");
    assert.equal(formColor("#123456"), "#123456");
    assert.equal(formColor(null), null);
    assert.equal(formColor(undefined), undefined);
  });
});
