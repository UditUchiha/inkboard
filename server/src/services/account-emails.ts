import { createHash, randomBytes } from "node:crypto";
import mongoose from "mongoose";
import type { Types } from "mongoose";
import { EmailToken } from "../models/email-token.model.ts";
import { User } from "../models/user.model.ts";
import type { UserDoc } from "../models/user.model.ts";
import { sendEmail } from "./email.ts";
import type { EmailPurpose } from "./email.ts";

// Emails about someone's account: a link to verify their address, and a link
// to reset their password. Each link holds a random secret that works once.

const HOUR_MS = 3600 * 1000;
export const LINK_LIFETIME_MS: Record<EmailPurpose, number> = {
  "verify-email": 72 * HOUR_MS,
  "reset-password": HOUR_MS,
};
// A new link isn't sent sooner than this after the last, so the address can't be flooded.
export const RESEND_AFTER_MS = 60 * 1000;

// Who a link email is for.
type Recipient = Pick<UserDoc, "_id" | "name" | "email">;

const hashOf = (secret: string) => createHash("sha256").update(secret).digest("hex");

/**
 * Creates a new link for `user` and `purpose` and sends it with `send(secret)`; once it's sent, earlier
 * links stop working. If sending fails, the new link is dropped and the earlier one keeps working, so
 * trying again isn't held up by a link that never arrived. Resolves false, sending nothing, if one was
 * made less than RESEND_AFTER_MS ago.
 */
async function sendLink(user: Recipient, purpose: EmailPurpose, send: (secret: string) => Promise<void>) {
  const recent = await EmailToken.exists({
    user: user._id,
    purpose,
    createdAt: { $gt: new Date(Date.now() - RESEND_AFTER_MS) },
  });
  if (recent) return false;
  const secret = randomBytes(32).toString("base64url");
  const token = await EmailToken.create({
    user: user._id,
    purpose,
    hash: hashOf(secret),
    expiresAt: new Date(Date.now() + LINK_LIFETIME_MS[purpose]),
  });
  try {
    await send(secret);
  } catch (error) {
    await EmailToken.deleteOne({ _id: token._id });
    throw error;
  }
  await EmailToken.deleteMany({ user: user._id, purpose, _id: { $ne: token._id } });
  return true;
}

/**
 * Uses up a link's secret. Resolves with the user id it was for, or null if it's unknown, used or expired.
 * With `userId`, only a link for that account is used up: one for another account is left working.
 */
export async function redeemSecret(secret: unknown, purpose: EmailPurpose, userId?: string) {
  if (typeof secret !== "string" || secret.length < 20 || secret.length > 100) return null;
  const filter: { hash: string; purpose: EmailPurpose; expiresAt: { $gt: Date }; user?: string } = {
    hash: hashOf(secret),
    purpose,
    expiresAt: { $gt: new Date() },
  };
  if (userId !== undefined) {
    if (!mongoose.isValidObjectId(userId)) return null;
    filter.user = userId;
  }
  const token = await EmailToken.findOneAndDelete(filter);
  return token ? token.user : null;
}

/** Forgets every outstanding link of one kind for a user (a password was just reset, say). */
export const forgetSecrets = (userId: Types.ObjectId | string, purpose: EmailPurpose) =>
  EmailToken.deleteMany({ user: userId, purpose });

const escapeHtml = (value: unknown) => String(value).replace(/[&<>"']/g, (char) => `&#${char.charCodeAt(0)};`);

interface LinkEmail {
  greeting: string;
  lines: string[];
  button: string;
  link: string;
  footer: string;
}

// A plain email with one button, and the same in text for clients that don't show HTML.
function linkEmail({ greeting, lines, button, link, footer }: LinkEmail) {
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
export function sendVerificationEmail(user: Recipient, appUrl: string) {
  return sendLink(user, "verify-email", (secret) =>
    sendEmail({
      to: user.email,
      purpose: "verify-email",
      subject: "Verify your email for Inkboard",
      ...linkEmail({
        greeting: `Hi ${user.name},`,
        lines: [
          "Please confirm that this is your email address. Once it's verified, people can invite you to their boards by email.",
          "You'll be asked to log in to your Inkboard account, then to confirm.",
          "The link works for 3 days.",
        ],
        button: "Verify my email",
        // `email` only lets the page tell when the wrong account is logged in; the server checks the link.
        link: `${appUrl}/verify-email?token=${secret}&email=${encodeURIComponent(user.email)}`,
        footer: "If you didn't create an Inkboard account, you can ignore this email.",
      }),
    }),
  );
}

/** Emails `user` a link to choose a new password. Resolves false if one went out under a minute ago. */
export function sendPasswordResetEmail(user: Recipient, appUrl: string) {
  return sendLink(user, "reset-password", (secret) =>
    sendEmail({
      to: user.email,
      purpose: "reset-password",
      subject: "Reset your Inkboard password",
      ...linkEmail({
        greeting: `Hi ${user.name},`,
        lines: [
          "Someone asked to reset the password for your Inkboard account. If it was you, choose a new one below.",
          "The link works for 1 hour, once.",
        ],
        button: "Choose a new password",
        link: `${appUrl}/reset-password?token=${secret}`,
        footer: "If you didn't ask for this, you can ignore this email: your password stays the same.",
      }),
    }),
  );
}

const PROVIDER_ACCOUNTS_MIGRATION = "verify-accounts-made-by-providers";

/**
 * Accounts from before emails were verified: those without a password were made
 * through Google or GitHub, which only give us verified addresses. Called at start-up,
 * but only does anything once: it leaves a record in the `migrations` collection, so later
 * starts skip the scan of every account. Every account made since has the field.
 * Accounts with a password stay unverified until their owner clicks a link.
 * Resolves with how many accounts it changed.
 */
export async function verifyAccountsMadeByProviders() {
  const migrations = mongoose.connection.collection<{ _id: string; ranAt?: Date }>("migrations");
  if (await migrations.findOne({ _id: PROVIDER_ACCOUNTS_MIGRATION })) return 0;
  const { modifiedCount } = await User.updateMany(
    { emailVerified: { $exists: false }, password: { $exists: false } },
    { $set: { emailVerified: true } },
  );
  await migrations.updateOne({ _id: PROVIDER_ACCOUNTS_MIGRATION }, { $set: { ranAt: new Date() } }, { upsert: true });
  return modifiedCount;
}
