import bcrypt from "bcryptjs";
import mongoose from "mongoose";

export const OAUTH_PROVIDERS = ["google", "github"];

const userSchema = new mongoose.Schema(
  {
    name: { type: String, required: true, trim: true, maxlength: 60 },
    email: { type: String, required: true, unique: true, lowercase: true, trim: true },
    // Accounts created through Google or GitHub have no password until they set one.
    password: { type: String, select: false },
    googleId: { type: String, unique: true, sparse: true, select: false },
    githubId: { type: String, unique: true, sparse: true, select: false },
    avatarUrl: { type: String, default: null },
    // Avatar and cursor color. Null means one is picked from the user's id.
    color: { type: String, default: null, match: /^#[0-9a-f]{6}$/i },
  },
  { timestamps: true },
);

userSchema.pre("save", async function hashPassword() {
  if (!this.isModified("password") || !this.password) return;
  this.password = await bcrypt.hash(this.password, 12);
});

userSchema.methods.verifyPassword = function verifyPassword(candidate) {
  if (!this.password) return Promise.resolve(false);
  return bcrypt.compare(candidate, this.password);
};

/** What other people may see about someone. */
userSchema.methods.toPublic = function toPublic() {
  return { id: this.id, name: this.name, email: this.email, color: this.color, avatarUrl: this.avatarUrl };
};

/** What the account holder sees. Needs `+password +googleId +githubId` selected. */
userSchema.methods.toAccount = function toAccount() {
  return {
    ...this.toPublic(),
    hasPassword: Boolean(this.password),
    providers: Object.fromEntries(OAUTH_PROVIDERS.map((provider) => [provider, Boolean(this[`${provider}Id`])])),
  };
};

export const User = mongoose.model("User", userSchema);
