import mongoose from "mongoose";

const { ObjectId, Mixed } = mongoose.Schema.Types;

// Who besides the owner and invited collaborators can open the board's link.
export const LINK_ACCESS = ["restricted", "view", "edit"];

const boardSchema = new mongoose.Schema(
  {
    title: { type: String, trim: true, maxlength: 80, default: "Untitled board" },
    owner: { type: ObjectId, ref: "User", required: true, index: true },
    collaborators: [{ type: ObjectId, ref: "User", index: true }],
    linkAccess: { type: String, enum: LINK_ACCESS, default: "restricted" },
    elements: { type: [Mixed], default: [] },
    // Elements removed lately: { id, version, versionNonce, at }. Only needed
    // when the board is opened for editing (see realtime/sessions.js).
    removed: { type: [Mixed], default: [], select: false },
    // People who starred the board on their dashboard.
    starredBy: [{ type: ObjectId, ref: "User", index: true }],
    // Set when the owner moves the board to the trash; it's deleted for good 30 days later.
    deletedAt: { type: Date, default: null, index: true },
    // Set when a trashed board starts being deleted for good (see destroyBoard): from then on it
    // can't be restored, and if the deletion is cut off, the next trash sweep finishes it.
    purgingAt: { type: Date, default: null },
    // Size of `elements` as MongoDB stores them, so what an owner keeps can be added up without
    // reading every drawing (see ownerBytes in services/boards.js). Written with the drawing; null
    // on boards saved before it was, until they're measured.
    bytes: { type: Number, default: null },
  },
  { timestamps: true, minimize: false },
);

// Adding up an owner's space reads only this index, not the boards.
boardSchema.index({ owner: 1, bytes: 1, _id: 1 });
// The trash sweep looks for boards being erased (see services/trash.js). Only those are in the
// index, so it stays tiny, and without it the sweep would read every board's drawing to find them.
boardSchema.index({ purgingAt: 1 }, { partialFilterExpression: { purgingAt: { $type: "date" } } });

export const Board = mongoose.model("Board", boardSchema);
