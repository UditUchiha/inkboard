import mongoose from "mongoose";

const { ObjectId } = mongoose.Schema.Types;

// "visitors" and "removals" warn an owner about what people from a board's link did there (see realtime/link-watch.ts).
export const NOTIFICATION_TYPES = [
  "mention",
  "reply",
  "invite",
  "suggestion",
  "trashed",
  "access",
  "visitors",
  "removals",
];

const notificationSchema = new mongoose.Schema(
  {
    user: { type: ObjectId, ref: "User", required: true },
    type: { type: String, enum: NOTIFICATION_TYPES, required: true },
    // Who did it. Someone suggesting changes can be a guest, who has no account: then only their name is kept.
    actor: { type: ObjectId, ref: "User", default: null },
    actorName: { type: String, maxlength: 40, default: null },
    board: { type: ObjectId, ref: "Board", required: true, index: true },
    thread: { type: ObjectId, default: null, index: true },
    // The start of a comment, or for a request for access the email address of the person asking.
    excerpt: { type: String, maxlength: 254, default: null },
    read: { type: Boolean, default: false },
    // Old notifications are removed automatically after 60 days.
    createdAt: { type: Date, default: Date.now, expires: 60 * 24 * 3600 },
  },
  { versionKey: false },
);

notificationSchema.index({ user: 1, createdAt: -1 });

export const Notification = mongoose.model("Notification", notificationSchema);
