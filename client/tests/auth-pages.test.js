import assert from "node:assert/strict";
import { register } from "node:module";
import { beforeEach, describe, it } from "node:test";
import { createElement } from "react";
import { renderToStaticMarkup } from "react-dom/server";
import { MemoryRouter } from "react-router";

// These tests render the auth provider and pages to HTML (no browser; effects don't run), so what's checked
// here is what a page shows for a given state, and what the provider's callbacks do when called. The
// decisions behind them are pure functions with their own tests (see auth-client.test.js).
register("./jsx-hooks.js", import.meta.url);
const { api } = await import("../src/lib/api.ts");
const { AuthContext, AuthProvider, useAuth } = await import("../src/providers/AuthProvider.tsx");
const { default: OAuthCallbackPage } = await import("../src/pages/OAuthCallbackPage.tsx");
const { VerifyEmailPage } = await import("../src/pages/AuthPages.tsx");

const TOKEN_KEY = "inkboard.token";
const realFetch = globalThis.fetch;

// The browser's localStorage, shared by every tab of the app (here, one tab and whatever the test plays).
function fakeStorage() {
  const items = new Map();
  return {
    getItem: (key) => items.get(key) ?? null,
    setItem: (key, value) => items.set(key, String(value)),
    removeItem: (key) => items.delete(key),
  };
}

// A login token for account `sub`: only the payload matters to the app, which doesn't check signatures.
const loginFor = (sub, version = 1) =>
  `h.${Buffer.from(JSON.stringify({ sub, v: version })).toString("base64url")}.signature`;

beforeEach(() => {
  globalThis.localStorage = fakeStorage();
  globalThis.sessionStorage = fakeStorage();
  globalThis.fetch = realFetch;
});

// Renders an AuthProvider and hands back what it gives the app.
function renderAuth() {
  let auth;
  function Grab() {
    auth = useAuth();
    return null;
  }
  renderToStaticMarkup(createElement(AuthProvider, null, createElement(Grab)));
  return auth;
}

// The login this tab makes its requests with now (null for none), seen as the server would see it.
async function tabLogin() {
  let sent;
  globalThis.fetch = async (url, init) => {
    sent = init.headers.Authorization ?? null;
    return new Response("{}");
  };
  await api.me();
  return sent?.replace("Bearer ", "") ?? null;
}

describe("logging out a tab (L30)", () => {
  it("forgets the stored login when it's this tab's", async () => {
    localStorage.setItem(TOKEN_KEY, "this-tabs-login");
    renderAuth().logout();
    assert.equal(localStorage.getItem(TOKEN_KEY), null);
    assert.equal(await tabLogin(), null);
  });

  it("leaves a newer login another tab stored alone, so that tab isn't logged out too", () => {
    localStorage.setItem(TOKEN_KEY, loginFor("ana", 1));
    const auth = renderAuth();
    // Another tab changed the password: its new login is stored, and this tab's old one gets a late 401.
    localStorage.setItem(TOKEN_KEY, loginFor("ana", 2));
    auth.logout();
    assert.equal(localStorage.getItem(TOKEN_KEY), loginFor("ana", 2));
  });

  it("never lands in another account when the person chose to log out", async () => {
    localStorage.setItem(TOKEN_KEY, loginFor("ana"));
    const auth = renderAuth();
    // Another tab logged in as someone else since.
    localStorage.setItem(TOKEN_KEY, loginFor("ben"));
    auth.logout();
    assert.equal(await tabLogin(), null, "this tab is logged out, not switched to Ben");
    assert.equal(localStorage.getItem(TOKEN_KEY), loginFor("ben"), "and Ben's tab keeps its login");
  });

  it("logs the tab out when the person chose to, even if another tab holds a newer login for the same account", async () => {
    localStorage.setItem(TOKEN_KEY, loginFor("ana", 1));
    const auth = renderAuth();
    localStorage.setItem(TOKEN_KEY, loginFor("ana", 2));
    auth.logout();
    assert.equal(await tabLogin(), null);
  });
});

describe("the Google and GitHub sign-in callback (M7)", () => {
  const renderCallback = (hash = "#code=a-code&next=%2Fboard%2Fabc") => {
    globalThis.window = { location: { hash, pathname: "/auth/callback" } };
    const value = { status: "anonymous", startSession: () => {} };
    return renderToStaticMarkup(createElement(AuthContext.Provider, { value }, createElement(OAuthCallbackPage)));
  };

  it("shows that it's signing in while the code is traded for a login", () => {
    assert.match(renderCallback(), /Signing you in/);
  });
});

describe("the page behind a verification link", () => {
  const render = ({ status = "authenticated", user = { email: "ana@example.test" }, search = "?token=abc" }) => {
    const value = { status, user, updateUser: () => {}, logout: () => {}, retry: () => {} };
    return renderToStaticMarkup(
      createElement(
        MemoryRouter,
        { initialEntries: [`/verify-email${search}`] },
        createElement(AuthContext.Provider, { value }, createElement(VerifyEmailPage)),
      ),
    );
  };

  it("says which account is logged in, and verifies that one", () => {
    const html = render({ search: "?token=abc&email=ana%40example.test" });
    assert.match(html, /Verify ana@example\.test/);
    assert.match(html, /logged in as ana@example\.test/);
    assert.match(html, /Switch account/, "for when it isn't theirs");
  });

  it("offers to switch, instead of a button that can't work, when the link is for another account (C5)", () => {
    const html = render({ search: "?token=abc&email=Ben%40example.test" });
    assert.match(html, /logged in as ana@example\.test, but this link was sent to a different account/);
    assert.match(html, /Switch account/);
    assert.doesNotMatch(html, /Verify ana@example/);
    assert.doesNotMatch(html, /ben@example/i, "text from the link isn't put on the page");
  });

  it("asks anyone logged out to log in first", () => {
    assert.match(render({ status: "anonymous", user: null }), /Log in to verify/);
  });

  it("says so when the server can't be reached, with a way to try again, instead of asking to log in", () => {
    const html = render({ status: "offline", user: null });
    assert.match(html, /couldn(&#x27;|')t reach the server/);
    assert.match(html, /Try again/);
    assert.doesNotMatch(html, /Log in to verify/);
  });

  it("explains a link without a token", () => {
    assert.match(render({ search: "" }), /This link is incomplete/);
  });
});
