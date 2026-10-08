import { env } from "../config/env.js";

// Sends email through Brevo's HTTP API (Render's free plan blocks SMTP ports).
// Without BREVO_API_KEY and EMAIL_FROM, emails aren't sent: they're kept in
// `outbox` (tests read it) and, in development, printed to the server log.

const BREVO_URL = "https://api.brevo.com/v3/smtp/email";
const OUTBOX_SIZE = 50;

/** Emails "sent" while no email service is configured, newest last. */
export const outbox = [];

export const emailConfigured = () => Boolean(env.email.brevoApiKey && env.email.from);

/** Sends one email. Throws if the email service refuses it. */
export async function sendEmail({ to, subject, text, html }) {
  if (!emailConfigured()) {
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
