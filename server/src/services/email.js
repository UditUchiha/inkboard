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

/** Whether email is set up, and with it email verification and password reset. */
export const emailConfigured = () => Boolean(env.email.brevoApiKey && env.email.from);

/** Sends one email. Throws if the email service refuses it. */
export async function sendEmail({ to, subject, text, html }) {
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
