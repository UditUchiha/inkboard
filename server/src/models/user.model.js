import mongoose from "mongoose";
import { hashPassword, verifyPasswordHash } from "../lib/passwords.js";

export const OAUTH_PROVIDERS = ["google", "github"];

const userSchema = new mongoose.Schema(
  {
    name: { type: String, required: true, trim: true, maxlength: 60 },
    email: { type: String, required: true, unique: true, lowercase: true, trim: true },
    // Whether the person has shown the address is theirs (a link sent to it, or
    // Google or GitHub vouching for it). Invites by email need it.
    emailVerified: { type: Boolean, default: false },
    // Accounts created through Google or GitHub have no password until they set one.
    password: { type: String, select: false },
    googleId: { type: String, unique: true, sparse: true, select: false },
    githubId: { type: String, unique: true, sparse: true, select: false },
    // Logins carry the version they were issued at; raising it ends all of them.
    // Accounts from before this existed have none, which counts as 0.
    tokenVersion: { type: Number, default: 0 },
    avatarUrl: { type: String, default: null },
    // Avatar and cursor color. Null means one is picked from the user's id.
    color: { type: String, default: null, match: /^#[0-9a-f]{6}$/i },
  },
  { timestamps: true },
);

userSchema.pre("save", async function hashNewPassword() {
  if (!this.isModified("password") || !this.password) return;
  this.password = await hashPassword(this.password);
});

/** Checks a password, and quietly upgrades a hash made with the older algorithm (needs `+password`). */
userSchema.methods.verifyPassword = async function verifyPassword(candidate) {
  if (!this.password) return false;
  const { ok, needsRehash } = await verifyPasswordHash(candidate, this.password);
  if (ok && needsRehash) {
    this.password = candidate;
    await this.save().catch(() => {}); // an upgrade that fails is retried at the next login
  }
  return ok;
};

/** Ends every login made so far; the caller saves the user. */
userSchema.methods.revokeSessions = function revokeSessions() {
  this.$inc("tokenVersion", 1);
};

/** What other people may see about someone. */
userSchema.methods.toPublic = function toPublic() {
  return { id: this.id, name: this.name, email: this.email, color: this.color, avatarUrl: this.avatarUrl };
};

/** What the account holder sees. Needs `+password +googleId +githubId` selected. */
userSchema.methods.toAccount = function toAccount() {
  return {
    ...this.toPublic(),
    emailVerified: this.emailVerified,
    hasPassword: Boolean(this.password),
    providers: Object.fromEntries(OAUTH_PROVIDERS.map((provider) => [provider, Boolean(this[`${provider}Id`])])),
  };
};

export const User = mongoose.model("User", userSchema);
