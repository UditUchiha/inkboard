import { createHash, randomBytes } from "node:crypto";
import mongoose from "mongoose";
import type { Types } from "mongoose";
import { EmailToken } from "../models/email-token.model.ts";
import { User } from "../models/user.model.ts";
import type { UserDoc } from "../models/user.model.ts";
import { sendEmail } from "./email.ts";
import type { EmailPurpose } from "./email.ts";

// Verify and reset links each hold a random secret that works once; also the email telling an owner someone asked for
// access.

const HOUR_MS = 3600 * 1000;
export const LINK_LIFETIME_MS: Record<EmailPurpose, number> = {
  "verify-email": 72 * HOUR_MS,
  "reset-password": HOUR_MS,
};
// so the address can't be flooded
export const RESEND_AFTER_MS = 60 * 1000;

type Recipient = Pick<UserDoc, "_id" | "name" | "email">;

const hashOf = (secret: string) => createHash("sha256").update(secret).digest("hex");

// Once sent, earlier links stop working; if sending fails the new link is dropped and the earlier one keeps working.
// Resolves false, sending nothing, if one was made less than RESEND_AFTER_MS ago.
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

// Resolves with the user id it was for, or null if unknown, used or expired. With `userId`, a link for another account
// is left working.
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
        // `email` only lets the page tell when the wrong account is logged in; the server checks the link
        link: `${appUrl}/verify-email?token=${secret}&email=${encodeURIComponent(user.email)}`,
        footer: "If you didn't create an Inkboard account, you can ignore this email.",
      }),
    }),
  );
}

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

export function sendAccessRequestEmail(
  owner: Recipient,
  requester: Pick<UserDoc, "name" | "email">,
  board: { _id: unknown; title: string },
  appUrl: string,
) {
  return sendEmail({
    to: owner.email,
    purpose: "access-request",
    subject: `${requester.name} asked for access to “${board.title}”`,
    ...linkEmail({
      greeting: `Hi ${owner.name},`,
      lines: [
        `${requester.name} (${requester.email}) asked to edit your board “${board.title}” on Inkboard.`,
        "If you'd like them to, open the board and invite them: their address is filled in for you.",
      ],
      button: "Open the board",
      link: `${appUrl}/board/${String(board._id)}?invite=${encodeURIComponent(requester.email)}`,
      footer: "If you don't know them, you can ignore this email: they can't see the board until you invite them.",
    }),
  });
}

const PROVIDER_ACCOUNTS_MIGRATION = "verify-accounts-made-by-providers";

// Accounts without a password were made through Google or GitHub, which give only verified addresses. Leaves a record
// in `migrations`, so later starts skip the scan; accounts made since have the field. Accounts with a password stay
// unverified until a link is clicked.
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
