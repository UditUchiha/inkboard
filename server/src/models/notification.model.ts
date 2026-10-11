import mongoose from "mongoose";

const { ObjectId } = mongoose.Schema.Types;

export const NOTIFICATION_TYPES = ["mention", "reply", "invite", "suggestion", "trashed"];

const notificationSchema = new mongoose.Schema(
  {
    user: { type: ObjectId, ref: "User", required: true },
    type: { type: String, enum: NOTIFICATION_TYPES, required: true },
    // Who did it. Someone suggesting changes can be a guest, who has no account: then only their name is kept.
    actor: { type: ObjectId, ref: "User", default: null },
    actorName: { type: String, maxlength: 40, default: null },
    board: { type: ObjectId, ref: "Board", required: true, index: true },
    thread: { type: ObjectId, default: null, index: true },
    excerpt: { type: String, maxlength: 140, default: null },
    read: { type: Boolean, default: false },
    // Old notifications are removed automatically after 60 days.
    createdAt: { type: Date, default: Date.now, expires: 60 * 24 * 3600 },
  },
  { versionKey: false },
);

notificationSchema.index({ user: 1, createdAt: -1 });

export const Notification = mongoose.model("Notification", notificationSchema);
