import mongoose from "mongoose";

const { ObjectId } = mongoose.Schema.Types;

export const NOTIFICATION_TYPES = ["mention", "reply", "invite"];

const notificationSchema = new mongoose.Schema(
  {
    user: { type: ObjectId, ref: "User", required: true },
    type: { type: String, enum: NOTIFICATION_TYPES, required: true },
    actor: { type: ObjectId, ref: "User", required: true },
    board: { type: ObjectId, ref: "Board", required: true, index: true },
    thread: { type: ObjectId, default: null },
    excerpt: { type: String, maxlength: 140, default: null },
    read: { type: Boolean, default: false },
    // Old notifications are removed automatically after 60 days.
    createdAt: { type: Date, default: Date.now, expires: 60 * 24 * 3600 },
  },
  { versionKey: false },
);

notificationSchema.index({ user: 1, createdAt: -1 });

export const Notification = mongoose.model("Notification", notificationSchema);
