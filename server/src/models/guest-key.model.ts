import mongoose from "mongoose";

// Which key each guest id belongs to (see guestIdentity in realtime/index.ts). A guest's id is shown to everyone on a
// board, so it can't be what proves who they are: the browser that first uses an id also sends a secret key, whose hash
// is kept here, and later connections with that id must send the same key. Forgotten after 180 days unused.
const guestKeySchema = new mongoose.Schema(
  {
    _id: { type: String, required: true }, // the guest id
    hash: { type: String, required: true },
    seenAt: { type: Date, default: Date.now, expires: 180 * 24 * 3600 },
  },
  { versionKey: false },
);

export const GuestKey = mongoose.model("GuestKey", guestKeySchema);
