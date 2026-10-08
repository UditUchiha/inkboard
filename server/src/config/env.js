import { fileURLToPath } from "node:url";

// Load server/.env when present. Variables already set in the environment win.
try {
  process.loadEnvFile(fileURLToPath(new URL("../../.env", import.meta.url)));
} catch {
  // No .env file: rely on the real environment (e.g. on the hosting provider).
}

const isProduction = process.env.NODE_ENV === "production";

function required(name, devFallback) {
  const value = process.env[name] || (isProduction ? undefined : devFallback);
  if (!value) {
    throw new Error(`Missing required environment variable: ${name}`);
  }
  return value;
}

function list(value) {
  return (value ?? "")
    .split(",")
    .map((item) => item.trim())
    .filter(Boolean);
}

export const env = {
  isProduction,
  port: Number(process.env.PORT) || 5000,
  mongoUri: required("MONGODB_URI", "mongodb://127.0.0.1:27017/inkboard"),
  jwtSecret: required("JWT_SECRET", "local-development-secret"),
  jwtExpiresIn: process.env.JWT_EXPIRES_IN || "7d",
  // Origins allowed to call the API from another domain. Leave empty when the
  // server also serves the client (same origin).
  clientOrigins: process.env.CLIENT_ORIGIN
    ? list(process.env.CLIENT_ORIGIN)
    : isProduction
      ? []
      : ["http://localhost:5173"],
  // Public address of the app, used in OAuth redirects. Leave empty to use the
  // address each request came in on (fine when the server hosts the client).
  appUrl: (process.env.APP_URL ?? "").replace(/\/$/, ""),
  // Emails (verifying an address, resetting a password) go through Brevo's API:
  // Render's free plan blocks SMTP. EMAIL_FROM must be a sender verified in Brevo.
  // Without them, emails are printed to the server log instead (development).
  email: {
    brevoApiKey: process.env.BREVO_API_KEY || null,
    from: process.env.EMAIL_FROM || null,
    fromName: process.env.EMAIL_FROM_NAME || "Inkboard",
  },
  // "Continue with Google / GitHub" only appears for providers configured here.
  oauth: {
    google: oauthClient("GOOGLE"),
    github: oauthClient("GITHUB"),
  },
};

function oauthClient(prefix) {
  const clientId = process.env[`${prefix}_CLIENT_ID`];
  const clientSecret = process.env[`${prefix}_CLIENT_SECRET`];
  return clientId && clientSecret ? { clientId, clientSecret } : null;
}
