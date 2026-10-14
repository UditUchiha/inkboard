import mongoose from "mongoose";
import type { InferSchemaType, Model } from "mongoose";
import type { Element } from "@inkboard/shared/types";

const { ObjectId, Mixed } = mongoose.Schema.Types;

// Who besides the owner and invited collaborators can open the board's link, and what they can do there.
export const LINK_ACCESS = ["restricted", "view", "suggest", "edit"];

const boardSchema = new mongoose.Schema(
  {
    title: { type: String, trim: true, maxlength: 80, default: "Untitled board" },
    owner: { type: ObjectId, ref: "User", required: true, index: true },
    collaborators: [{ type: ObjectId, ref: "User", index: true }],
    linkAccess: { type: String, enum: LINK_ACCESS, default: "restricted" },
    // A password the link asks for (hashed), and a random key that is set with it and changes whenever it does:
    // the key is the pass people are given for the password, so a new password, or none, ends every pass (see
    // services/link-pass.ts). The key is never sent to anyone else. Members never need either.
    linkPassword: { type: String, default: null, select: false },
    linkKey: { type: String, default: null },
    // Signed-in people who gave the password, so the board stays on their dashboard. Cleared with the key.
    linkUnlocked: [{ type: ObjectId, ref: "User" }],
    // When the link stops opening the board (for anyone but its members), or null.
    linkExpiresAt: { type: Date, default: null },
    // Whether people who open the board by its link can watch its replay too (members always can). It shows what
    // was drawn and later removed, so it's off until the owner turns it on.
    linkReplay: { type: Boolean, default: false },
    elements: { type: [Mixed], default: [] },
    // Elements removed lately: { id, version, versionNonce, at }. Only needed
    // when the board is opened for editing (see realtime/sessions.ts).
    removed: { type: [Mixed], default: [], select: false },
    // Changes people with a "suggest" link proposed, for a member to accept or reject (see
    // shared/src/suggestions.ts). Kept and saved with the open board, like its elements.
    suggestions: { type: [Mixed], default: [], select: false },
    // The board's timer and its round of dot voting, while there are any (see realtime/countdown.ts and
    // realtime/voting.ts). Saved with the open board, so they carry on when everyone has left and comes back.
    countdown: { type: Mixed, default: null, select: false },
    voting: { type: Mixed, default: null, select: false },
    // Private mode, while it's on (see "private" in realtime/index.ts): who turned it on. Saved the same way.
    privateMode: { type: Mixed, default: null, select: false },
    // People who starred the board on their dashboard.
    starredBy: [{ type: ObjectId, ref: "User", index: true }],
    // Set when the owner moves the board to the trash; it's deleted for good 30 days later.
    deletedAt: { type: Date, default: null, index: true },
    // Set when a trashed board starts being deleted for good (see destroyBoard): from then on it
    // can't be restored, and if the deletion is cut off, the next trash sweep finishes it.
    purgingAt: { type: Date, default: null },
    // Size of `elements` as MongoDB stores them, so what an owner keeps can be added up without
    // reading every drawing (see ownerBytes in services/boards.ts). Written with the drawing; null
    // on boards saved before it was, until they're measured.
    bytes: { type: Number, default: null },
  },
  { timestamps: true, minimize: false },
);

// Adding up an owner's space reads only this index, not the boards.
boardSchema.index({ owner: 1, bytes: 1, _id: 1 });
// The trash sweep looks for boards being erased (see services/trash.ts). Only those are in the
// index, so it stays tiny, and without it the sweep would read every board's drawing to find them.
boardSchema.index({ purgingAt: 1 }, { partialFilterExpression: { purgingAt: { $type: "date" } } });

// Mongoose can only infer `elements` as `any[]` from Mixed, so the type says what is stored in it.
type BoardFields = Omit<InferSchemaType<typeof boardSchema>, "elements"> & { elements: Element[] };

export const Board = mongoose.model<BoardFields, Model<BoardFields>>("Board", boardSchema);
