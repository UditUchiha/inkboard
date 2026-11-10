import { fileURLToPath } from "node:url";
import type { SignOptions } from "jsonwebtoken";

try {
  process.loadEnvFile(fileURLToPath(new URL("../../.env", import.meta.url)));
} catch {
  // no .env file: rely on the real environment (e.g. on the hosting provider)
}

const mode = process.env.NODE_ENV;
const isProduction = mode === "production";
// development defaults (a signing secret) only for these two modes: a start without NODE_ENV (Docker, a VPS) mustn't quietly sign logins with a public secret
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

export type TokenLifetime = NonNullable<SignOptions["expiresIn"]>;

// jsonwebtoken reads a bare number such as "3600" as milliseconds; it means seconds
function lifetime(value: string | undefined): TokenLifetime {
  const text = (value ?? "").trim() || "7d";
  return /^\d+$/.test(text) ? Number(text) : (text as TokenLifetime);
}

// proxies between the internet and this server, for the client address behind rate limits; hosts differ (Render's is 1)
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
  mongoUri: required("MONGODB_URI", `mongodb://127.0.0.1:${Number(process.env.DEV_DB_PORT) || 27017}/inkboard`),
  jwtSecret: signingSecret(),
  jwtExpiresIn: lifetime(process.env.JWT_EXPIRES_IN),
  // origins allowed to call the API from another domain; empty when the server also serves the client
  clientOrigins: process.env.CLIENT_ORIGIN
    ? list(process.env.CLIENT_ORIGIN)
    : isProduction
      ? []
      : ["http://localhost:5173"],
  // Where sign-in sends people back and email links point. Without APP_URL the request's own address is used (see lib/app-url.ts), which keeps sign-in working on a custom domain.
  appUrl: (process.env.APP_URL ?? "").replace(/\/$/, ""),
  // Render's own address, only for email links when APP_URL isn't set (a fixed address, unlike the Host header, but not necessarily the one people use), so sign-in never redirects to it
  renderUrl: (process.env.CLIENT_ORIGIN ? "" : (process.env.RENDER_EXTERNAL_URL ?? "")).replace(/\/$/, ""),
  // where Google and GitHub send people back; only needed when it differs from APP_URL
  apiUrl: (process.env.API_URL ?? "").replace(/\/$/, ""),
  // Brevo's API, as Render's free plan blocks SMTP; EMAIL_FROM must be a sender verified in Brevo. Without them emails are printed to the log (development).
  email: {
    brevoApiKey: process.env.BREVO_API_KEY || null,
    from: process.env.EMAIL_FROM || null,
    fromName: process.env.EMAIL_FROM_NAME || "Inkboard",
    // Brevo's free plan allows 300 a day; stay under it so a flood of requests can't use it up
    dailyLimit: Number(process.env.EMAIL_DAILY_LIMIT) || 250,
  },
  // all four or none (see docs/image-storage.md); without them images stay in MongoDB (GridFS)
  r2: r2Settings(),
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

export interface R2Settings {
  accountId: string;
  accessKeyId: string;
  secretAccessKey: string;
  bucket: string;
}

// All four or none: a half-set R2 would otherwise quietly keep images in the database.
function r2Settings(): R2Settings | null {
  const names = ["R2_ACCOUNT_ID", "R2_ACCESS_KEY_ID", "R2_SECRET_ACCESS_KEY", "R2_BUCKET"];
  const [accountId, accessKeyId, secretAccessKey, bucket] = names.map((name) => process.env[name]?.trim() ?? "");
  const missing = names.filter((name) => !process.env[name]?.trim());
  if (missing.length === names.length) return null;
  if (missing.length > 0) {
    throw new Error(
      `Missing required environment variable: ${missing.join(", ")} (R2 needs all of ${names.join(", ")}).`,
    );
  }
  return { accountId: accountId!, accessKeyId: accessKeyId!, secretAccessKey: secretAccessKey!, bucket: bucket! };
}

function oauthClient(prefix: string) {
  const clientId = process.env[`${prefix}_CLIENT_ID`];
  const clientSecret = process.env[`${prefix}_CLIENT_SECRET`];
  return clientId && clientSecret ? { clientId, clientSecret } : null;
}
