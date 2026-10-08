import { createHash, randomBytes } from "node:crypto";
import { EmailToken } from "../models/email-token.model.js";
import { User } from "../models/user.model.js";
import { sendEmail } from "./email.js";

// Emails about someone's account: a link to verify their address, and a link
// to reset their password. Each link holds a random secret that works once.

const HOUR_MS = 3600 * 1000;
export const LINK_LIFETIME_MS = { "verify-email": 72 * HOUR_MS, "reset-password": HOUR_MS };
// A new link isn't sent sooner than this after the last, so the address can't be flooded.
export const RESEND_AFTER_MS = 60 * 1000;

const hashOf = (secret) => createHash("sha256").update(secret).digest("hex");

/**
 * A new link secret for `user` and `purpose`, replacing any earlier one, or
 * null if one was sent less than RESEND_AFTER_MS ago.
 */
async function issueSecret(user, purpose) {
  const recent = await EmailToken.exists({
    user: user._id,
    purpose,
    createdAt: { $gt: new Date(Date.now() - RESEND_AFTER_MS) },
  });
  if (recent) return null;
  await EmailToken.deleteMany({ user: user._id, purpose });
  const secret = randomBytes(32).toString("base64url");
  await EmailToken.create({
    user: user._id,
    purpose,
    hash: hashOf(secret),
    expiresAt: new Date(Date.now() + LINK_LIFETIME_MS[purpose]),
  });
  return secret;
}

/** Uses up a link's secret. Resolves with the user id it was for, or null if it's unknown, used or expired. */
export async function redeemSecret(secret, purpose) {
  if (typeof secret !== "string" || secret.length < 20 || secret.length > 100) return null;
  const token = await EmailToken.findOneAndDelete({ hash: hashOf(secret), purpose, expiresAt: { $gt: new Date() } });
  return token ? token.user : null;
}

/** Forgets every outstanding link of one kind for a user (a password was just reset, say). */
export const forgetSecrets = (userId, purpose) => EmailToken.deleteMany({ user: userId, purpose });

const escapeHtml = (value) => String(value).replace(/[&<>"']/g, (char) => `&#${char.charCodeAt(0)};`);

// A plain email with one button, and the same in text for clients that don't show HTML.
function linkEmail({ greeting, lines, button, link, footer }) {
  const text = [greeting, "", ...lines, "", `${button}: ${link}`, "", footer].join("\n");
  const html = `<div style="font-family:system-ui,-apple-system,Segoe UI,sans-serif;font-size:15px;line-height:1.5;color:#16213a;max-width:480px">
<p>${escapeHtml(greeting)}</p>
${lines.map((line) => `<p>${escapeHtml(line)}</p>`).join("\n")}
<p><a href="${escapeHtml(link)}" style="display:inline-block;background:#16213a;color:#ffffff;text-decoration:none;padding:10px 18px;border-radius:8px;font-weight:600">${escapeHtml(button)}</a></p>
<p style="color:#5c6577;font-size:13px">If the button doesn't work, open this link: <a href="${escapeHtml(link)}">${escapeHtml(link)}</a></p>
<p style="color:#5c6577;font-size:13px">${escapeHtml(footer)}</p>
</div>`;
  return { text, html };
}

/**
 * Emails `user` a link that verifies their address. `appUrl` is where the app
 * is served. Resolves false (sending nothing) if one went out under a minute ago.
 */
export async function sendVerificationEmail(user, appUrl) {
  const secret = await issueSecret(user, "verify-email");
  if (!secret) return false;
  const link = `${appUrl}/verify-email?token=${secret}`;
  await sendEmail({
    to: user.email,
    subject: "Verify your email for Inkboard",
    ...linkEmail({
      greeting: `Hi ${user.name},`,
      lines: [
        "Please confirm that this is your email address. Once it's verified, people can invite you to their boards by email.",
        "The link works for 3 days.",
      ],
      button: "Verify my email",
      link,
      footer: "If you didn't create an Inkboard account, you can ignore this email.",
    }),
  });
  return true;
}

/** Emails `user` a link to choose a new password. Resolves false if one went out under a minute ago. */
export async function sendPasswordResetEmail(user, appUrl) {
  const secret = await issueSecret(user, "reset-password");
  if (!secret) return false;
  const link = `${appUrl}/reset-password?token=${secret}`;
  await sendEmail({
    to: user.email,
    subject: "Reset your Inkboard password",
    ...linkEmail({
      greeting: `Hi ${user.name},`,
      lines: [
        "Someone asked to reset the password for your Inkboard account. If it was you, choose a new one below.",
        "The link works for 1 hour, once.",
      ],
      button: "Choose a new password",
      link,
      footer: "If you didn't ask for this, you can ignore this email: your password stays the same.",
    }),
  });
  return true;
}

/**
 * Accounts from before emails were verified: those without a password were made
 * through Google or GitHub, which only give us verified addresses. Runs at start-up;
 * accounts with a password stay unverified until their owner clicks a link.
 */
export async function verifyAccountsMadeByProviders() {
  const { modifiedCount } = await User.updateMany(
    { emailVerified: { $exists: false }, password: { $exists: false } },
    { $set: { emailVerified: true } },
  );
  return modifiedCount;
}
