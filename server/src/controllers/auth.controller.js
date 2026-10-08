import { clientUrlFor } from "../lib/app-url.js";
import { HttpError } from "../lib/http-error.js";
import { signToken } from "../lib/tokens.js";
import { User } from "../models/user.model.js";
import { refreshUser } from "../realtime/index.js";
import { forgetSecrets, redeemSecret, sendPasswordResetEmail, sendVerificationEmail } from "../services/account-emails.js";
import { emailConfigured } from "../services/email.js";

const EMAIL_PATTERN = /^[^\s@]+@[^\s@]+\.[^\s@]+$/;
const COLOR_PATTERN = /^#[0-9a-f]{6}$/i;
const ACCOUNT_FIELDS = "+password +googleId +githubId";

function readCredentials(body) {
  return {
    email: String(body?.email ?? "").trim().toLowerCase(),
    password: String(body?.password ?? ""),
  };
}

function readName(value) {
  const name = String(value ?? "").trim();
  if (!name) throw new HttpError(400, "Enter your name.");
  if (name.length > 60) throw new HttpError(400, "Use 60 characters or fewer for your name.");
  return name;
}

function checkNewPassword(password) {
  if (password.length < 8) throw new HttpError(400, "Use at least 8 characters for your password.");
  if (Buffer.byteLength(password) > 72) {
    throw new HttpError(400, "Use 72 characters or fewer for your password.");
  }
}

async function findAccount(userId) {
  const user = await User.findById(userId).select(ACCOUNT_FIELDS);
  if (!user) throw new HttpError(401, "This account no longer exists.");
  return user;
}

export async function register(req, res) {
  const name = readName(req.body?.name);
  const { email, password } = readCredentials(req.body);

  if (!EMAIL_PATTERN.test(email)) throw new HttpError(400, "Enter a valid email address.");
  checkNewPassword(password);

  if (await User.exists({ email })) {
    throw new HttpError(409, "An account with this email already exists. Log in instead.");
  }

  const user = await User.create({ name, email, password });
  // The account works straight away; the address is verified when they click the link.
  if (emailConfigured()) {
    try {
      await sendVerificationEmail(user, clientUrlFor(req));
    } catch (error) {
      console.error(`Couldn't send the verification email: ${error.message}`);
    }
  }
  res.status(201).json({ token: signToken(user), user: user.toAccount() });
}

export async function login(req, res) {
  const { email, password } = readCredentials(req.body);
  if (!email || !password) throw new HttpError(400, "Enter your email and password.");

  const user = await User.findOne({ email }).select(ACCOUNT_FIELDS);
  if (user && !user.password) {
    const via = user.googleId ? "Google" : "GitHub";
    throw new HttpError(401, `This account signs in with ${via}. Use the ${via} button below.`);
  }
  if (!user || !(await user.verifyPassword(password))) {
    throw new HttpError(401, "That email and password don't match an account.");
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

/** Changes the password, or sets a first one on an account made with Google or GitHub. */
export async function changePassword(req, res) {
  const user = await findAccount(req.userId);
  const current = String(req.body?.currentPassword ?? "");
  const next = String(req.body?.newPassword ?? "");

  if (user.password && !(await user.verifyPassword(current))) {
    throw new HttpError(400, "Your current password isn't right.");
  }
  checkNewPassword(next);

  user.password = next;
  await user.save();
  res.json({ user: user.toAccount() });
}

// Verification and password reset need email, which may not be set up yet.
function requireEmail() {
  if (!emailConfigured()) throw new HttpError(503, "Emails aren't set up on this server yet, so this isn't available.");
}

/** Verifies an address from the link emailed to it. Works without being logged in. */
export async function verifyEmail(req, res) {
  const userId = await redeemSecret(req.body?.token, "verify-email");
  const user = userId && (await User.findById(userId));
  if (!user) throw new HttpError(400, "This link has expired or was already used. Log in and ask for a new one.");
  if (!user.emailVerified) {
    user.emailVerified = true;
    await user.save();
  }
  res.json({ email: user.email });
}

/** Sends the verification link again, to the logged-in person. */
export async function resendVerification(req, res) {
  requireEmail();
  const user = await findAccount(req.userId);
  if (user.emailVerified) throw new HttpError(400, "Your email is already verified.");
  let sent;
  try {
    sent = await sendVerificationEmail(user, clientUrlFor(req));
  } catch (error) {
    console.error(`Couldn't send the verification email: ${error.message}`);
    throw new HttpError(502, "The email couldn't be sent. Try again in a few minutes.");
  }
  if (!sent) throw new HttpError(429, "We just sent you one. Check your inbox and spam folder, or try again in a minute.");
  res.json({ sent: true });
}

/**
 * Emails a password-reset link, if an account uses the address. The answer is
 * the same either way, so this can't be used to find out who has an account.
 */
export async function forgotPassword(req, res) {
  requireEmail();
  const { email } = readCredentials(req.body);
  if (!EMAIL_PATTERN.test(email)) throw new HttpError(400, "Enter a valid email address.");
  const user = await User.findOne({ email });
  if (user) {
    try {
      await sendPasswordResetEmail(user, clientUrlFor(req));
    } catch (error) {
      console.error(`Couldn't send a password reset email: ${error.message}`);
    }
  }
  res.json({ sent: true });
}

/**
 * Sets a new password from a reset link, and logs the person in. Following the
 * link proves the address is theirs, so it also counts as verifying it.
 */
export async function resetPassword(req, res) {
  const password = String(req.body?.password ?? "");
  checkNewPassword(password); // before using up the link, so a too-short password can be fixed and retried
  const userId = await redeemSecret(req.body?.token, "reset-password");
  const user = userId && (await findAccount(userId).catch(() => null));
  if (!user) throw new HttpError(400, "This link has expired or was already used. Ask for a new one.");

  user.password = password;
  user.emailVerified = true;
  await user.save();
  await forgetSecrets(user._id, "reset-password");
  res.json({ token: signToken(user), user: user.toAccount() });
}
