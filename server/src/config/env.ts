import { fileURLToPath } from "node:url";
import type { SignOptions } from "jsonwebtoken";

// Load server/.env when present. Variables already set in the environment win.
try {
  process.loadEnvFile(fileURLToPath(new URL("../../.env", import.meta.url)));
} catch {
  // No .env file: rely on the real environment (e.g. on the hosting provider).
}

const mode = process.env.NODE_ENV;
const isProduction = mode === "production";
// Built-in development defaults (a signing secret) are only for these two modes. A start without
// NODE_ENV (a Docker image or a VPS, say) must not quietly sign logins with a secret that's public.
const isLocal = mode === "development" || mode === "test";

const MIN_SECRET_BYTES = 32;
const DEV_SECRET = "local-development-secret";

function required(name: string, devFallback: string) {
  const value = process.env[name] || (isProduction ? undefined : devFallback);
  if (!value) {
    throw new Error(`Missing required environment variable: ${name}`);
  }
  return value;
}

function signingSecret() {
  const secret = process.env.JWT_SECRET;
  if (secret && Buffer.byteLength(secret) >= MIN_SECRET_BYTES) return secret;
  if (!isLocal) {
    throw new Error(
      secret
        ? `JWT_SECRET is too short (${Buffer.byteLength(secret)} bytes; it needs at least ${MIN_SECRET_BYTES}), so the server won't start. ` +
            `Replace it where this server's environment is set (on Render: the service's Environment page) with a new random one, ` +
            `made with: node -e "console.log(require('crypto').randomBytes(48).toString('hex'))". ` +
            `Everyone is logged out once, as logins signed with the old secret stop working.`
        : "Missing required environment variable: JWT_SECRET (set NODE_ENV=development to use a built-in secret for local work only)",
    );
  }
  if (mode !== "test") {
    console.warn(
      `WARNING: ${secret ? "JWT_SECRET is shorter than 32 characters" : "JWT_SECRET isn't set, so logins are signed with a public development secret"}. This is fine for local development; never run a real server like this.`,
    );
  }
  return secret || DEV_SECRET;
}

/** How long a token lasts: seconds, or text such as "7d" (see jsonwebtoken's `expiresIn`). */
export type TokenLifetime = NonNullable<SignOptions["expiresIn"]>;

// A bare number such as "3600" would be read by jsonwebtoken as milliseconds; it means seconds.
function lifetime(value: string | undefined): TokenLifetime {
  const text = (value ?? "").trim() || "7d";
  // jsonwebtoken checks the text's format itself (and throws when signing if it's wrong); the type can't say that.
  return /^\d+$/.test(text) ? Number(text) : (text as TokenLifetime);
}

// How many proxies sit between the internet and this server, for the client address
// behind rate limits. Hosts differ (Render's is 1), so it can be set with TRUST_PROXY.
function trustProxy() {
  const value = process.env.TRUST_PROXY;
  if (value === undefined || value === "") return isProduction ? 1 : false;
  return /^\d+$/.test(value) ? Number(value) : value === "true" ? true : value === "false" ? false : value;
}

function list(value: string | undefined) {
  return (value ?? "")
    .split(",")
    .map((item) => item.trim())
    .filter(Boolean);
}

export const env = {
  isProduction,
  trustProxy: trustProxy(),
  port: Number(process.env.PORT) || 5000,
  // The fallback is the local database `npm run dev` starts (see scripts/dev-db.js, which listens on DEV_DB_PORT).
  mongoUri: required("MONGODB_URI", `mongodb://127.0.0.1:${Number(process.env.DEV_DB_PORT) || 27017}/inkboard`),
  jwtSecret: signingSecret(),
  jwtExpiresIn: lifetime(process.env.JWT_EXPIRES_IN),
  // Origins allowed to call the API from another domain. Leave empty when the
  // server also serves the client (same origin).
  clientOrigins: process.env.CLIENT_ORIGIN
    ? list(process.env.CLIENT_ORIGIN)
    : isProduction
      ? []
      : ["http://localhost:5173"],
  // Where people open the app: the address sign-in sends them back to and email links point at.
  // Only what APP_URL says. Without it, the address each request came in on is used (see
  // lib/app-url.ts), which is what keeps sign-in working on a custom domain.
  appUrl: (process.env.APP_URL ?? "").replace(/\/$/, ""),
  // The service's own address on Render (onrender.com), when it also serves the app (no CLIENT_ORIGIN).
  // Only for email links when APP_URL isn't set: it's a fixed address, unlike the Host header, but it
  // isn't necessarily the one people use (a custom domain), so sign-in never redirects to it.
  renderUrl: (process.env.CLIENT_ORIGIN ? "" : (process.env.RENDER_EXTERNAL_URL ?? "")).replace(/\/$/, ""),
  // Public address of this API, which is where Google and GitHub send people back to. Only
  // needed when it differs from APP_URL (client and API on different addresses).
  apiUrl: (process.env.API_URL ?? "").replace(/\/$/, ""),
  // Emails (verifying an address, resetting a password) go through Brevo's API:
  // Render's free plan blocks SMTP. EMAIL_FROM must be a sender verified in Brevo.
  // Without them, emails are printed to the server log instead (development).
  email: {
    brevoApiKey: process.env.BREVO_API_KEY || null,
    from: process.env.EMAIL_FROM || null,
    fromName: process.env.EMAIL_FROM_NAME || "Inkboard",
    // Brevo's free plan allows 300 emails a day; stay under it so a flood of requests can't use it all up.
    dailyLimit: Number(process.env.EMAIL_DAILY_LIMIT) || 250,
  },
  // "Continue with Google / GitHub" only appears for providers configured here.
  oauth: {
    google: oauthClient("GOOGLE"),
    github: oauthClient("GITHUB"),
  },
};

if (mode !== "test" && !isProduction && !isLocal) {
  console.warn(
    "WARNING: NODE_ENV isn't set to production or development, so the server runs with production-only safeguards off " +
      "(proxy trust, the CORS lock-down, hiding links in logs). Set NODE_ENV=production when deploying.",
  );
}
if (isProduction && env.email.brevoApiKey && env.email.from && !env.appUrl) {
  if (!env.renderUrl) {
    // Links in emails would be built from the Host header, which a request can set to any site.
    throw new Error(
      "Missing required environment variable: APP_URL, the address people open the app at (e.g. https://inkboard.example.com). " +
        "Emails link to it, and it's needed once BREVO_API_KEY and EMAIL_FROM are set.",
    );
  }
  console.warn(
    `WARNING: APP_URL isn't set, so links in emails point to ${env.renderUrl} (this service's Render address). ` +
      "If people open the app at a custom domain, set APP_URL to it.",
  );
}

function oauthClient(prefix: string) {
  const clientId = process.env[`${prefix}_CLIENT_ID`];
  const clientSecret = process.env[`${prefix}_CLIENT_SECRET`];
  return clientId && clientSecret ? { clientId, clientSecret } : null;
}
