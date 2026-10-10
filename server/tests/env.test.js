import assert from "node:assert/strict";
import { spawnSync } from "node:child_process";
import { describe, it } from "node:test";
import { fileURLToPath } from "node:url";

// config/env.js reads the environment once, when it's first imported, so each case
// loads it in a fresh process with exactly the variables given.
const envModule = fileURLToPath(new URL("../src/config/env.js", import.meta.url)).replaceAll("\\", "/");
const SECRET = "s".repeat(48);

const appUrlModule = fileURLToPath(new URL("../src/lib/app-url.js", import.meta.url)).replaceAll("\\", "/");

// `script` runs with `env` loaded and whatever it logs last is the answer; by default that's `env` itself.
function load(variables, script = "console.log(JSON.stringify(env));") {
  const result = spawnSync(
    process.execPath,
    ["--input-type=module", "-e", `const { env } = await import("file:///${envModule}"); ${script}`],
    {
      // Blank, not absent: variables already set win over a developer's server/.env.
      env: {
        PATH: process.env.PATH,
        SystemRoot: process.env.SystemRoot,
        JWT_SECRET: "",
        MONGODB_URI: "",
        NODE_ENV: "",
        APP_URL: "",
        RENDER_EXTERNAL_URL: "",
        API_URL: "",
        CLIENT_ORIGIN: "",
        JWT_EXPIRES_IN: "",
        TRUST_PROXY: "",
        BREVO_API_KEY: "",
        EMAIL_FROM: "",
        ...variables,
      },
      encoding: "utf8",
    },
  );
  return {
    ok: result.status === 0,
    env: result.status === 0 ? JSON.parse(result.stdout.trim().split("\n").at(-1)) : null,
    stderr: result.stderr,
  };
}

describe("the signing secret (M5)", () => {
  it("has no built-in fallback unless the server is explicitly in development or test", () => {
    for (const NODE_ENV of ["", "staging", "production"]) {
      const result = load({ NODE_ENV, MONGODB_URI: "mongodb://db/x" });
      assert.equal(result.ok, false, `NODE_ENV=${NODE_ENV}`);
      assert.match(result.stderr, /JWT_SECRET/);
    }
    for (const NODE_ENV of ["development", "test"]) {
      const result = load({ NODE_ENV });
      assert.equal(result.ok, true, `NODE_ENV=${NODE_ENV}`);
      assert.equal(result.env.jwtSecret, "local-development-secret");
    }
  });

  it("warns loudly in development, and stays quiet in tests", () => {
    assert.match(load({ NODE_ENV: "development" }).stderr, /WARNING.*JWT_SECRET/);
    assert.equal(load({ NODE_ENV: "test" }).stderr, "");
  });

  it("must be at least 32 characters outside development", () => {
    const weak = load({ NODE_ENV: "production", MONGODB_URI: "mongodb://db/x", JWT_SECRET: "short" });
    assert.equal(weak.ok, false);
    assert.match(weak.stderr, /too short \(5 bytes; it needs at least 32\)/);
    assert.match(weak.stderr, /Environment page/, "says where to change it");
    assert.match(weak.stderr, /randomBytes\(48\)/, "and how to make a new one");
    assert.equal(load({ NODE_ENV: "production", MONGODB_URI: "mongodb://db/x", JWT_SECRET: SECRET }).ok, true);
    assert.equal(load({ NODE_ENV: "development", JWT_SECRET: "short" }).env.jwtSecret, "short");
  });
});

describe("how long a login lasts (L11)", () => {
  it("reads a bare number as seconds, and keeps units", () => {
    const expires = (JWT_EXPIRES_IN) => load({ NODE_ENV: "test", JWT_EXPIRES_IN }).env.jwtExpiresIn;
    assert.equal(expires("3600"), 3600);
    assert.equal(expires("12h"), "12h");
    assert.equal(expires(""), "7d");
  });
});

// What lib/app-url.js makes of a request that came in on `host` (and, optionally, from `origin`).
function urlsFor(variables, { host = "ink.example.test", origin } = {}) {
  const script = `
    const { apiUrlFor, clientUrlFor, emailLinkUrlFor } = await import("file:///${appUrlModule}");
    const headers = { host: ${JSON.stringify(host)}, origin: ${JSON.stringify(origin)} };
    const req = { protocol: "https", get: (name) => headers[name.toLowerCase()] };
    console.log(JSON.stringify({ api: apiUrlFor(req), client: clientUrlFor(req), email: emailLinkUrlFor(req) }));`;
  return load(variables, script);
}

describe("links in emails (M4)", () => {
  const production = { NODE_ENV: "production", MONGODB_URI: "mongodb://db/x", JWT_SECRET: SECRET };

  it("need APP_URL in production once email is on, so the Host header can't choose them", () => {
    const email = { BREVO_API_KEY: "key", EMAIL_FROM: "inkboard@example.test" };
    const missing = load({ ...production, ...email });
    assert.equal(missing.ok, false);
    assert.match(missing.stderr, /APP_URL/);
    assert.equal(
      load({ ...production, ...email, APP_URL: "https://ink.example.test/" }).env.appUrl,
      "https://ink.example.test",
    );
    assert.equal(load(production).ok, true, "without email there are no links to protect");
  });

  it("fall back to the service's own address on Render, with a warning, when APP_URL isn't set", () => {
    const email = { BREVO_API_KEY: "key", EMAIL_FROM: "inkboard@example.test" };
    const render = { ...production, ...email, RENDER_EXTERNAL_URL: "https://inkboard.onrender.com/" };
    const fallback = load(render);
    assert.equal(fallback.ok, true);
    assert.equal(fallback.env.renderUrl, "https://inkboard.onrender.com");
    assert.equal(fallback.env.appUrl, "", "it isn't taken for the app's address (see the next test)");
    assert.match(fallback.stderr, /WARNING: APP_URL isn't set.*inkboard\.onrender\.com.*custom domain/);
    const explicit = load({ ...render, APP_URL: "https://ink.example.test" });
    assert.equal(explicit.env.appUrl, "https://ink.example.test");
    assert.equal(explicit.stderr, "");
    // With the app elsewhere, the API's own address isn't where people open it.
    const split = load({ ...render, CLIENT_ORIGIN: "https://app.example.test" });
    assert.equal(split.ok, false);
    assert.match(split.stderr, /APP_URL/);
  });
});

describe("addresses the server builds from a request (a custom domain on Render)", () => {
  const render = { NODE_ENV: "production", MONGODB_URI: "mongodb://db/x", JWT_SECRET: SECRET };
  const onRender = { ...render, RENDER_EXTERNAL_URL: "https://inkboard.onrender.com" };
  const email = { BREVO_API_KEY: "key", EMAIL_FROM: "inkboard@example.test" };

  it("keep the address the request came in on, so sign-in works on a custom domain that never set APP_URL", () => {
    // The state cookie is set at the custom domain's API address, so the provider must send people back to it.
    const urls = urlsFor(onRender).env;
    assert.equal(urls.api, "https://ink.example.test", "the callback address (redirect_uri)");
    assert.equal(urls.client, "https://ink.example.test", "where the browser goes after sign-in");
  });

  it("only use APP_URL when it was set, and let it win", () => {
    const set = urlsFor({ ...onRender, APP_URL: "https://app.example.test/" }).env;
    assert.deepEqual(set, {
      api: "https://app.example.test",
      client: "https://app.example.test",
      email: "https://app.example.test",
    });
  });

  it("send the browser back to an allowed client origin, as before", () => {
    const split = urlsFor(
      { ...render, CLIENT_ORIGIN: "https://app.example.test", API_URL: "https://api.example.test" },
      { origin: "https://app.example.test" },
    ).env;
    assert.equal(split.client, "https://app.example.test");
    assert.equal(split.api, "https://api.example.test");
  });

  it("link emails to Render's address only where no APP_URL says better, and never to the Host header", () => {
    assert.equal(
      urlsFor({ ...onRender, ...email }, { host: "evil.example" }).env.email,
      "https://inkboard.onrender.com",
    );
    // Without email in play there's nothing to protect, and local work uses the request's address.
    assert.equal(urlsFor({ NODE_ENV: "test" }, { host: "localhost:5000" }).env.email, "https://localhost:5000");
  });
});

describe("addresses and proxies", () => {
  it("keeps API_URL apart from APP_URL, and lets TRUST_PROXY say how many proxies there are (M9, M10)", () => {
    const split = load({ NODE_ENV: "test", APP_URL: "https://app.test/", API_URL: "https://api.test/" }).env;
    assert.equal(split.appUrl, "https://app.test");
    assert.equal(split.apiUrl, "https://api.test");
    assert.equal(load({ NODE_ENV: "production", MONGODB_URI: "mongodb://db/x", JWT_SECRET: SECRET }).env.trustProxy, 1);
    assert.equal(load({ NODE_ENV: "test" }).env.trustProxy, false);
    assert.equal(load({ NODE_ENV: "test", TRUST_PROXY: "2" }).env.trustProxy, 2);
  });
});
