import { env } from "../config/env.js";

// Sends email through Brevo's HTTP API (Render's free plan blocks SMTP ports).
// Email is optional: without BREVO_API_KEY and EMAIL_FROM, the features that
// need it (verifying addresses, resetting passwords) are switched off, and
// setting them later switches those on with no other change. Tests never send:
// their emails are kept in `outbox` to be read back.

const BREVO_URL = "https://api.brevo.com/v3/smtp/email";
const OUTBOX_SIZE = 50;

/** Emails "sent" by tests, or while no email service is configured, newest last. */
export const outbox = [];

let budgetDay = "";
let sentToday = 0;

/**
 * How many emails this server process has sent since midnight UTC. The count lives in memory: it starts
 * again at 0 when the process restarts, and each process (if there were several) counts its own.
 */
export function emailsSentToday() {
  return budgetDay === new Date().toISOString().slice(0, 10) ? sentToday : 0;
}

// Brevo stops sending for the day at its quota, and sign-ups and reset requests are open to anyone.
// Password resets are what someone locked out of their account needs, so this share of the day's
// allowance is kept for them: a flood of sign-ups (each sends a verification email) can't use it up.
export const RESERVED_FOR_RESETS = 0.4;

function takeDailySlot(purpose) {
  const today = new Date().toISOString().slice(0, 10);
  if (today !== budgetDay) {
    budgetDay = today;
    sentToday = 0;
  }
  const { dailyLimit } = env.email;
  const limit = purpose === "reset-password" ? dailyLimit : dailyLimit - Math.ceil(dailyLimit * RESERVED_FOR_RESETS);
  if (sentToday >= limit) return false;
  sentToday += 1;
  return true;
}

/** Whether email is set up, and with it email verification and password reset. */
export const emailConfigured = () => Boolean(env.email.brevoApiKey && env.email.from);

/**
 * Sends one email. Throws if the email service refuses it, or the daily limit is used up. `purpose` is
 * "reset-password" for a password reset, which may use the share of the limit kept for those.
 */
export async function sendEmail({ to, subject, text, html, purpose }) {
  if (!takeDailySlot(purpose))
    throw new Error(`The daily limit of ${env.email.dailyLimit} emails is used up; "${subject}" wasn't sent.`);
  if (!emailConfigured() || process.env.NODE_ENV === "test") {
    outbox.push({ to, subject, text, html });
    if (outbox.length > OUTBOX_SIZE) outbox.shift();
    if (env.isProduction) {
      // Never log the content: it holds sign-in links.
      console.warn(`Email isn't set up (BREVO_API_KEY, EMAIL_FROM), so "${subject}" wasn't sent.`);
    } else if (process.env.NODE_ENV !== "test") {
      console.log(`\n--- Email to ${to}: ${subject} ---\n${text}\n---`);
    }
    return;
  }

  const response = await fetch(BREVO_URL, {
    method: "POST",
    headers: { "api-key": env.email.brevoApiKey, "content-type": "application/json", accept: "application/json" },
    body: JSON.stringify({
      sender: { name: env.email.fromName, email: env.email.from },
      to: [{ email: to }],
      subject,
      textContent: text,
      htmlContent: html,
    }),
    signal: AbortSignal.timeout(10_000),
  });
  if (!response.ok) {
    throw new Error(`Brevo didn't send "${subject}" (${response.status}): ${(await response.text()).slice(0, 300)}`);
  }
}
