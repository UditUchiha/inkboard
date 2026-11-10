import { env } from "../config/env.ts";

// Brevo's HTTP API (Render's free plan blocks SMTP). Email is optional: without BREVO_API_KEY and EMAIL_FROM, verifying
// addresses and resetting passwords are off. Tests keep their emails in `outbox`.

const BREVO_URL = "https://api.brevo.com/v3/smtp/email";
const OUTBOX_SIZE = 50;

export interface SentEmail {
  to: string;
  subject: string;
  text: string;
  html: string;
}

export type EmailPurpose = "verify-email" | "reset-password";

export const outbox: SentEmail[] = [];

let budgetDay = "";
let sentToday = 0;

// in memory: it starts again at 0 when the process restarts, and each process counts its own
export function emailsSentToday() {
  return budgetDay === new Date().toISOString().slice(0, 10) ? sentToday : 0;
}

// Brevo stops sending at its quota and sign-ups and reset requests are open to anyone, so this share is kept for resets
// (what a locked-out person needs): a flood of sign-ups can't use it up.
export const RESERVED_FOR_RESETS = 0.4;

function takeDailySlot(purpose: EmailPurpose | "access-request") {
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

export const emailConfigured = () => Boolean(env.email.brevoApiKey && env.email.from);

// Throws if the service refuses or the daily limit is used up. `purpose` "reset-password" may use the share kept for
// resets.
export async function sendEmail({
  to,
  subject,
  text,
  html,
  purpose,
}: SentEmail & { purpose: EmailPurpose | "access-request" }) {
  if (!takeDailySlot(purpose))
    throw new Error(`The daily limit of ${env.email.dailyLimit} emails is used up; "${subject}" wasn't sent.`);
  if (!emailConfigured() || process.env.NODE_ENV === "test") {
    outbox.push({ to, subject, text, html });
    if (outbox.length > OUTBOX_SIZE) outbox.shift();
    if (env.isProduction) {
      console.warn(`Email isn't set up (BREVO_API_KEY, EMAIL_FROM), so "${subject}" wasn't sent.`);
    } else if (process.env.NODE_ENV !== "test") {
      console.log(`\n--- Email to ${to}: ${subject} ---\n${text}\n---`);
    }
    return;
  }

  const response = await fetch(BREVO_URL, {
    method: "POST",
    headers: { "api-key": env.email.brevoApiKey!, "content-type": "application/json", accept: "application/json" },
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
