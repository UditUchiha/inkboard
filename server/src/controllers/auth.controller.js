import { emailLinkUrlFor } from "../lib/app-url.ts";
import { MAX_EMAIL_LENGTH, isEmailAddress } from "../lib/email-address.ts";
import { HttpError } from "../lib/http-error.ts";
import { spendPasswordTime, waitOutSlowestCheck } from "../lib/passwords.ts";
import { signToken } from "../lib/tokens.ts";
import { assertRecentLogin } from "../middleware/auth.ts";
import { OAUTH_PROVIDERS, User } from "../models/user.model.ts";
import { disconnectUser, refreshUser } from "../realtime/index.js";
import {
  forgetSecrets,
  redeemSecret,
  sendPasswordResetEmail,
  sendVerificationEmail,
} from "../services/account-emails.js";
import { emailConfigured } from "../services/email.js";

const COLOR_PATTERN = /^#[0-9a-f]{6}$/i;
const ACCOUNT_FIELDS = "+password +googleId +githubId";

function readCredentials(body) {
  return {
    email: String(body?.email ?? "")
      .trim()
      .toLowerCase(),
    password: String(body?.password ?? ""),
  };
}

function readName(value) {
  const name = String(value ?? "").trim();
  if (!name) throw new HttpError(400, "Enter your name.");
  if (name.length > 60) throw new HttpError(400, "Use 60 characters or fewer for your name.");
  return name;
}

const MAX_PASSWORD_LENGTH = 128;

function checkNewPassword(password) {
  if (password.length < 8) throw new HttpError(400, "Use at least 8 characters for your password.");
  if (password.length > MAX_PASSWORD_LENGTH) {
    throw new HttpError(400, `Use ${MAX_PASSWORD_LENGTH} characters or fewer for your password.`);
  }
}

// Mail is sent after the answer, so that how long a request takes doesn't depend on the mail service
// (or, for password resets, on whether the address has an account). Failures are logged, not shown.
function sendInBackground(sending, what) {
  sending.catch((error) => console.error(`Couldn't send ${what}: ${error.message}`));
}

// Disconnects Google and GitHub from the account. Returns whether there was anything to disconnect.
function releaseProviders(user) {
  const linked = OAUTH_PROVIDERS.filter((provider) => user[`${provider}Id`]);
  for (const provider of linked) user[`${provider}Id`] = undefined;
  return linked.length > 0;
}

// Logs the account out everywhere: every token made so far stops working and open sockets are closed.
// The caller hands the person a new token if they should stay logged in.
async function endAllSessions(user) {
  user.revokeSessions();
  await user.save();
  disconnectUser(user.id);
}

async function findAccount(userId) {
  const user = await User.findById(userId).select(ACCOUNT_FIELDS);
  if (!user) throw new HttpError(401, "This account no longer exists.");
  return user;
}

export async function register(req, res) {
  const name = readName(req.body?.name);
  const { email, password } = readCredentials(req.body);

  if (!isEmailAddress(email)) throw new HttpError(400, "Enter a valid email address.");
  checkNewPassword(password);

  const exists = () => new HttpError(409, "An account with this email already exists. Log in instead.");
  if (await User.exists({ email })) throw exists();

  let user;
  try {
    user = await User.create({ name, email, password });
  } catch (error) {
    if (error?.code === 11000) throw exists(); // someone signed up with it a moment ago
    throw error;
  }
  // The account works straight away; the address is verified when they click the link.
  if (emailConfigured()) sendInBackground(sendVerificationEmail(user, emailLinkUrlFor(req)), "the verification email");
  res.status(201).json({ token: signToken(user), user: user.toAccount() });
}

export async function login(req, res) {
  const { email, password } = readCredentials(req.body);
  if (!email || !password) throw new HttpError(400, "Enter your email and password.");

  const startedAt = performance.now();
  const user = email.length <= MAX_EMAIL_LENGTH ? await User.findOne({ email }).select(ACCOUNT_FIELDS) : null;
  // Every outcome takes about as long and says the same, so neither can show whether an address has an account.
  let ok = false;
  if (user?.password) ok = await user.verifyPassword(password);
  else await spendPasswordTime(password);
  if (!ok) {
    await waitOutSlowestCheck(startedAt);
    throw new HttpError(
      401,
      "That email and password don't match an account. If you signed up with Google or GitHub, use its button.",
    );
  }

  res.json({ token: signToken(user), user: user.toAccount() });
}

export async function me(req, res) {
  const user = await findAccount(req.userId);
  res.json({ user: user.toAccount() });
}

export async function updateProfile(req, res) {
  const user = await findAccount(req.userId);
  if (req.body?.name !== undefined) user.name = readName(req.body.name);
  if (req.body?.color !== undefined) {
    const { color } = req.body;
    if (color !== null && !COLOR_PATTERN.test(String(color))) {
      throw new HttpError(400, "Choose one of the colors shown.");
    }
    user.color = color;
  }
  await user.save();
  await refreshUser(user);
  res.json({ user: user.toAccount() });
}

/**
 * Changes the password, or sets a first one on an account made with Google or GitHub (which takes a
 * recent login, as there's no old password to prove who is asking). Every other login ends; the
 * response carries a new token for this one.
 */
export async function changePassword(req, res) {
  const user = await findAccount(req.userId);
  const current = String(req.body?.currentPassword ?? "");
  const next = String(req.body?.newPassword ?? "");

  if (user.password) {
    if (!(await user.verifyPassword(current))) throw new HttpError(400, "Your current password isn't right.");
  } else {
    assertRecentLogin(req);
  }
  checkNewPassword(next);

  user.password = next;
  await endAllSessions(user);
  await forgetSecrets(user._id, "reset-password");
  res.json({ token: signToken(user), user: user.toAccount() });
}

// Verification and password reset need email, which may not be set up yet.
function requireEmail() {
  if (!emailConfigured()) throw new HttpError(503, "Emails aren't set up on this server yet, so this isn't available.");
}

/**
 * Verifies an address from the link emailed to it, for the account the person is logged in to (C5).
 * The link proves who holds the inbox, and the login proves they hold the account's password, so
 * verifying ties the two together. Without the login, someone who signed up with another person's
 * address could have the owner's click verify it for them: they'd get the owner's invites, and could
 * then connect their own Google or GitHub, which a later password reset by the owner would keep.
 * Nobody else needs logging out here: every login to an unverified account comes from its password
 * (providers can't be connected before verifying), which the person verifying has just shown they hold.
 */
export async function verifyEmail(req, res) {
  const userId = await redeemSecret(req.body?.token, "verify-email", req.userId);
  const user = userId && (await User.findById(userId).select(ACCOUNT_FIELDS));
  if (!user) {
    throw new HttpError(
      400,
      "This link has expired, was already used, or is for a different account. Log in to the account it was sent for, or ask for a new link.",
    );
  }
  if (!user.emailVerified) {
    user.emailVerified = true;
    await user.save();
  }
  res.json({ email: user.email, user: user.toAccount() });
}

/** Logs the account out on every device, this one included (a lost phone, a shared computer). */
export async function logoutEverywhere(req, res) {
  await endAllSessions(await findAccount(req.userId));
  res.status(204).end();
}

/** Sends the verification link again, to the logged-in person. */
export async function resendVerification(req, res) {
  requireEmail();
  const user = await findAccount(req.userId);
  if (user.emailVerified) throw new HttpError(400, "Your email is already verified.");
  let sent;
  try {
    sent = await sendVerificationEmail(user, emailLinkUrlFor(req));
  } catch (error) {
    console.error(`Couldn't send the verification email: ${error.message}`);
    throw new HttpError(502, "The email couldn't be sent. Try again in a few minutes.");
  }
  if (!sent)
    throw new HttpError(429, "We just sent you one. Check your inbox and spam folder, or try again in a minute.");
  res.json({ sent: true });
}

/**
 * Emails a password-reset link, if an account uses the address. The answer is
 * the same either way, so this can't be used to find out who has an account.
 */
export async function forgotPassword(req, res) {
  requireEmail();
  const { email } = readCredentials(req.body);
  if (!isEmailAddress(email)) throw new HttpError(400, "Enter a valid email address.");
  const user = await User.findOne({ email });
  if (user) sendInBackground(sendPasswordResetEmail(user, emailLinkUrlFor(req)), "a password reset email");
  res.json({ sent: true });
}

/**
 * Sets a new password from a reset link, and logs the person in. Following the
 * link proves the address is theirs, so it also counts as verifying it. Every
 * earlier login ends, and so do providers linked before the address was verified
 * (whoever signed up with the address first could have connected their own).
 * Providers connected after verifying stay: verifying takes a login, so the
 * account's password was already the inbox owner's when they were connected.
 */
export async function resetPassword(req, res) {
  const password = String(req.body?.password ?? "");
  checkNewPassword(password); // before using up the link, so a too-short password can be fixed and retried
  const userId = await redeemSecret(req.body?.token, "reset-password");
  const user = userId && (await findAccount(userId).catch(() => null));
  if (!user) throw new HttpError(400, "This link has expired or was already used. Ask for a new one.");

  user.password = password;
  if (!user.emailVerified) releaseProviders(user);
  user.emailVerified = true;
  await endAllSessions(user);
  await forgetSecrets(user._id, "reset-password");
  res.json({ token: signToken(user), user: user.toAccount() });
}
