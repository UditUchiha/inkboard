import { HttpError } from "../lib/http-error.js";
import { signToken } from "../lib/tokens.js";
import { User } from "../models/user.model.js";

const EMAIL_PATTERN = /^[^\s@]+@[^\s@]+\.[^\s@]+$/;

function readCredentials(body) {
  return {
    email: String(body?.email ?? "").trim().toLowerCase(),
    password: String(body?.password ?? ""),
  };
}

export async function register(req, res) {
  const name = String(req.body?.name ?? "").trim();
  const { email, password } = readCredentials(req.body);

  if (!name) throw new HttpError(400, "Enter your name.");
  if (name.length > 60) throw new HttpError(400, "Use 60 characters or fewer for your name.");
  if (!EMAIL_PATTERN.test(email)) throw new HttpError(400, "Enter a valid email address.");
  if (password.length < 8) throw new HttpError(400, "Use at least 8 characters for your password.");
  if (Buffer.byteLength(password) > 72) {
    throw new HttpError(400, "Use 72 characters or fewer for your password.");
  }

  if (await User.exists({ email })) {
    throw new HttpError(409, "An account with this email already exists. Log in instead.");
  }

  const user = await User.create({ name, email, password });
  res.status(201).json({ token: signToken(user), user: user.toPublic() });
}

export async function login(req, res) {
  const { email, password } = readCredentials(req.body);
  if (!email || !password) throw new HttpError(400, "Enter your email and password.");

  const user = await User.findOne({ email }).select("+password");
  if (!user || !(await user.verifyPassword(password))) {
    throw new HttpError(401, "That email and password don't match an account.");
  }

  res.json({ token: signToken(user), user: user.toPublic() });
}

export async function me(req, res) {
  const user = await User.findById(req.userId);
  if (!user) throw new HttpError(401, "This account no longer exists.");
  res.json({ user: user.toPublic() });
}
