import type { AccountUser, OAuthProvider, PublicUser } from "@inkboard/shared/api";
import mongoose from "mongoose";
import type { HydratedDocument, InferSchemaType, Model } from "mongoose";
import { hashPassword, verifyPasswordHash } from "../lib/passwords.ts";

export type { OAuthProvider };
export const OAUTH_PROVIDERS: OAuthProvider[] = ["google", "github"];

const userSchema = new mongoose.Schema(
  {
    name: { type: String, required: true, trim: true, maxlength: 60 },
    email: { type: String, required: true, unique: true, lowercase: true, trim: true },
    // a link sent to it, or Google or GitHub vouching for it; invites by email need it
    emailVerified: { type: Boolean, default: false },
    password: { type: String, select: false },
    googleId: { type: String, unique: true, sparse: true, select: false },
    githubId: { type: String, unique: true, sparse: true, select: false },
    // raising it ends all logins; accounts from before it existed have none, which counts as 0
    tokenVersion: { type: Number, default: 0 },
    avatarUrl: { type: String, default: null },
    color: { type: String, default: null, match: /^#[0-9a-f]{6}$/i },
  },
  { timestamps: true },
);

interface UserMethods {
  verifyPassword(candidate: string): Promise<boolean>;
  revokeSessions(): void;
  toPublic(): PublicUser;
  toAccount(): AccountUser;
}

type UserFields = InferSchemaType<typeof userSchema>;

export type UserDoc = HydratedDocument<UserFields, UserMethods>;

type UserModel = Model<UserFields, {}, UserMethods, {}, UserDoc>;

userSchema.pre("save", async function hashNewPassword() {
  if (!this.isModified("password") || !this.password) return;
  this.password = await hashPassword(this.password);
});

userSchema.methods.verifyPassword = async function verifyPassword(this: UserDoc, candidate: string) {
  if (!this.password) return false;
  const { ok, needsRehash } = await verifyPasswordHash(candidate, this.password);
  if (ok && needsRehash) {
    this.password = candidate;
    await this.save().catch(() => {}); // an upgrade that fails is retried at the next login
  }
  return ok;
};

userSchema.methods.revokeSessions = function revokeSessions(this: UserDoc) {
  this.$inc("tokenVersion", 1);
};

userSchema.methods.toPublic = function toPublic(this: UserDoc): PublicUser {
  return { id: this.id, name: this.name, email: this.email, color: this.color, avatarUrl: this.avatarUrl };
};

userSchema.methods.toAccount = function toAccount(this: UserDoc): AccountUser {
  return {
    ...this.toPublic(),
    emailVerified: this.emailVerified,
    hasPassword: Boolean(this.password),
    providers: Object.fromEntries(OAUTH_PROVIDERS.map((provider) => [provider, Boolean(this[`${provider}Id`])])),
  };
};

export const User = mongoose.model<UserFields, UserModel>("User", userSchema);
