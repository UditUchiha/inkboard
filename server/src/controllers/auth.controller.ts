import type { Session, SentReply, UserReply, VerifiedEmailReply } from "@inkboard/shared/api";
import type { Request, Response } from "express";
import { emailLinkUrlFor } from "../lib/app-url.ts";
import { MAX_EMAIL_LENGTH, isEmailAddress } from "../lib/email-address.ts";
import { HttpError } from "../lib/http-error.ts";
import { spendPasswordTime, waitOutSlowestCheck } from "../lib/passwords.ts";
import { signToken } from "../lib/tokens.ts";
import { assertRecentLogin } from "../middleware/auth.ts";
import { OAUTH_PROVIDERS, User } from "../models/user.model.ts";
import type { UserDoc } from "../models/user.model.ts";
import { disconnectUser, refreshUser } from "../realtime/index.ts";
import {
  forgetSecrets,
  redeemSecret,
  sendPasswordResetEmail,
  sendVerificationEmail,
} from "../services/account-emails.ts";
import type { ObjectIdLike } from "../services/boards.ts";
import { emailConfigured } from "../services/email.ts";

const COLOR_PATTERN = /^#[0-9a-f]{6}$/i;
const ACCOUNT_FIELDS = "+password +googleId +githubId";

// bodies come from anyone, so every field is unknown until checked, and a body is missing when nothing was sent
interface CredentialsBody {
  email?: unknown;
  password?: unknown;
}

type BodyRequest<Body> = Request<{}, unknown, Body | undefined>;

function readCredentials(body: CredentialsBody | undefined) {
  return {
    email: String(body?.email ?? "")
      .trim()
      .toLowerCase(),
    password: String(body?.password ?? ""),
  };
}

function readName(value: unknown) {
  const name = String(value ?? "").trim();
  if (!name) throw new HttpError(400, "Enter your name.");
  if (name.length > 60) throw new HttpError(400, "Use 60 characters or fewer for your name.");
  return name;
}

const MAX_PASSWORD_LENGTH = 128;

function checkNewPassword(password: string) {
  if (password.length < 8) throw new HttpError(400, "Use at least 8 characters for your password.");
  if (password.length > MAX_PASSWORD_LENGTH) {
    throw new HttpError(400, `Use ${MAX_PASSWORD_LENGTH} characters or fewer for your password.`);
  }
}

// after the answer, so a request's duration doesn't depend on the mail service (or, for resets, on whether the address
// has an account)
function sendInBackground(sending: Promise<unknown>, what: string) {
  sending.catch((error: Error) => console.error(`Couldn't send ${what}: ${error.message}`));
}

function releaseProviders(user: UserDoc) {
  const linked = OAUTH_PROVIDERS.filter((provider) => user[`${provider}Id`]);
  for (const provider of linked) user[`${provider}Id`] = undefined;
  return linked.length > 0;
}

// every token made so far stops working and open sockets close; the caller hands the person a new token if they should
// stay
async function endAllSessions(user: UserDoc) {
  user.revokeSessions();
  await user.save();
  disconnectUser(user.id);
}

async function findAccount(userId: ObjectIdLike | undefined) {
  const user = await User.findById(userId).select(ACCOUNT_FIELDS);
  if (!user) throw new HttpError(401, "This account no longer exists.");
  return user;
}

export async function register(req: BodyRequest<CredentialsBody & { name?: unknown }>, res: Response) {
  const name = readName(req.body?.name);
  const { email, password } = readCredentials(req.body);

  if (!isEmailAddress(email)) throw new HttpError(400, "Enter a valid email address.");
  checkNewPassword(password);

  const exists = () => new HttpError(409, "An account with this email already exists. Log in instead.");
  if (await User.exists({ email })) throw exists();

  let user: UserDoc;
  try {
    user = await User.create({ name, email, password });
  } catch (error) {
    if ((error as { code?: unknown } | null)?.code === 11000) throw exists();
    throw error;
  }
  if (emailConfigured()) sendInBackground(sendVerificationEmail(user, emailLinkUrlFor(req)), "the verification email");
  res.status(201).json({ token: signToken(user), user: user.toAccount() } satisfies Session);
}

export async function login(req: BodyRequest<CredentialsBody>, res: Response) {
  const { email, password } = readCredentials(req.body);
  if (!email || !password) throw new HttpError(400, "Enter your email and password.");

  const startedAt = performance.now();
  const user = email.length <= MAX_EMAIL_LENGTH ? await User.findOne({ email }).select(ACCOUNT_FIELDS) : null;
  // every outcome takes about as long and says the same, so neither shows whether an address has an account
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

  res.json({ token: signToken(user!), user: user!.toAccount() } satisfies Session);
}

export async function me(req: Request, res: Response) {
  const user = await findAccount(req.userId);
  res.json({ user: user.toAccount() } satisfies UserReply);
}

export async function updateProfile(req: BodyRequest<{ name?: unknown; color?: unknown }>, res: Response) {
  const user = await findAccount(req.userId);
  if (req.body?.name !== undefined) user.name = readName(req.body.name);
  if (req.body?.color !== undefined) {
    const { color } = req.body;
    // strings first: the pattern coerces its input, so ["#aabbcc"] would pass
    if (color !== null && (typeof color !== "string" || !COLOR_PATTERN.test(color))) {
      throw new HttpError(400, "Choose one of the colors shown.");
    }
    user.color = color;
  }
  await user.save();
  await refreshUser(user);
  res.json({ user: user.toAccount() } satisfies UserReply);
}

// Setting a first password on an account made with Google or GitHub takes a recent login (there's no old password to
// prove who is asking).
export async function changePassword(
  req: BodyRequest<{ currentPassword?: unknown; newPassword?: unknown }>,
  res: Response,
) {
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
  res.json({ token: signToken(user), user: user.toAccount() } satisfies Session);
}

function requireEmail() {
  if (!emailConfigured()) throw new HttpError(503, "Emails aren't set up on this server yet, so this isn't available.");
}

// Needs the login too (C5): the link proves who holds the inbox, the login proves they hold the account. Without it,
// someone who signed up with another person's address could have the owner's click verify it for them, get the owner's
// invites, and connect their own Google or GitHub, which a later password reset would keep. No other logins need
// ending: every login to an unverified account is by its password, which the person verifying has just shown they hold.
export async function verifyEmail(req: BodyRequest<{ token?: unknown }>, res: Response) {
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
  res.json({ email: user.email, user: user.toAccount() } satisfies VerifiedEmailReply);
}

export async function logoutEverywhere(req: Request, res: Response) {
  await endAllSessions(await findAccount(req.userId));
  res.status(204).end();
}

export async function resendVerification(req: Request, res: Response) {
  requireEmail();
  const user = await findAccount(req.userId);
  if (user.emailVerified) throw new HttpError(400, "Your email is already verified.");
  let sent;
  try {
    sent = await sendVerificationEmail(user, emailLinkUrlFor(req));
  } catch (error) {
    console.error(`Couldn't send the verification email: ${(error as Error).message}`);
    throw new HttpError(502, "The email couldn't be sent. Try again in a few minutes.");
  }
  if (!sent)
    throw new HttpError(429, "We just sent you one. Check your inbox and spam folder, or try again in a minute.");
  res.json({ sent: true } satisfies SentReply);
}

// the answer is the same either way, so it can't show who has an account
export async function forgotPassword(req: BodyRequest<CredentialsBody>, res: Response) {
  requireEmail();
  const { email } = readCredentials(req.body);
  if (!isEmailAddress(email)) throw new HttpError(400, "Enter a valid email address.");
  const user = await User.findOne({ email });
  if (user) sendInBackground(sendPasswordResetEmail(user, emailLinkUrlFor(req)), "a password reset email");
  res.json({ sent: true } satisfies SentReply);
}

// Following the link proves the address is theirs, so it counts as verifying it. Providers linked before verifying are
// dropped (whoever signed up with the address first could have connected their own); later ones stay, since verifying
// takes a login, so the account's password was already the inbox owner's.
export async function resetPassword(req: BodyRequest<{ password?: unknown; token?: unknown }>, res: Response) {
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
  res.json({ token: signToken(user), user: user.toAccount() } satisfies Session);
}
