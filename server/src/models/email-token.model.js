import mongoose from "mongoose";

const { ObjectId } = mongoose.Schema.Types;

// One-time links sent by email: to verify an address, or to reset a password.
// Only a hash of each link's secret is kept, so a copy of the database can't be
// used to take over accounts. MongoDB deletes them once they expire.
export const EMAIL_TOKEN_PURPOSES = ["verify-email", "reset-password"];

const emailTokenSchema = new mongoose.Schema(
  {
    user: { type: ObjectId, ref: "User", required: true },
    purpose: { type: String, enum: EMAIL_TOKEN_PURPOSES, required: true },
    hash: { type: String, required: true, unique: true },
    expiresAt: { type: Date, required: true },
  },
  { timestamps: { createdAt: true, updatedAt: false } },
);

emailTokenSchema.index({ user: 1, purpose: 1 });
emailTokenSchema.index({ expiresAt: 1 }, { expireAfterSeconds: 0 });

export const EmailToken = mongoose.model("EmailToken", emailTokenSchema);
