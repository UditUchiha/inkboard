import { HttpError } from "../lib/http-error.js";
import { signToken } from "../lib/tokens.js";
import { User } from "../models/user.model.js";
import { refreshUser } from "../realtime/index.js";

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
