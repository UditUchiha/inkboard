import mongoose from "mongoose";
import type { InferSchemaType, Model } from "mongoose";
import type { Element } from "@inkboard/shared/types";

const { ObjectId, Mixed } = mongoose.Schema.Types;

export const LINK_ACCESS = ["restricted", "view", "suggest", "edit"];

const boardSchema = new mongoose.Schema(
  {
    title: { type: String, trim: true, maxlength: 80, default: "Untitled board" },
    owner: { type: ObjectId, ref: "User", required: true, index: true },
    collaborators: [{ type: ObjectId, ref: "User", index: true }],
    linkAccess: { type: String, enum: LINK_ACCESS, default: "restricted" },
    // hashed password, and a random key set with it that changes whenever it does: the key is the pass people are
    // given, so a new password, or none, ends every pass (see services/link-pass.ts). Never sent to anyone else;
    // members need neither.
    linkPassword: { type: String, default: null, select: false },
    linkKey: { type: String, default: null },
    linkUnlocked: [{ type: ObjectId, ref: "User" }],
    linkExpiresAt: { type: Date, default: null },
    // members always can; replay shows what was drawn and later removed, so it's off until the owner turns it on
    linkReplay: { type: Boolean, default: false },
    elements: { type: [Mixed], default: [] },
    // { id, version, versionNonce, at }; only needed when the board is opened for editing (see realtime/sessions.ts)
    removed: { type: [Mixed], default: [], select: false },
    // proposed by "suggest" links, for a member to accept or reject (see shared/src/suggestions.ts); saved with the
    // open board like its elements
    suggestions: { type: [Mixed], default: [], select: false },
    // saved with the open board, so they carry on when everyone has left and comes back
    countdown: { type: Mixed, default: null, select: false },
    voting: { type: Mixed, default: null, select: false },
    privateMode: { type: Mixed, default: null, select: false },
    classroom: { type: Mixed, default: null, select: false },
    starredBy: [{ type: ObjectId, ref: "User", index: true }],
    deletedAt: { type: Date, default: null, index: true },
    // from then on it can't be restored, and if the deletion is cut off the next trash sweep finishes it (see
    // destroyBoard)
    purgingAt: { type: Date, default: null },
    // of `elements` as MongoDB stores them, so an owner's space adds up without reading every drawing (see ownerBytes);
    // null on boards saved before it existed, until measured
    bytes: { type: Number, default: null },
  },
  { timestamps: true, minimize: false },
);

boardSchema.index({ owner: 1, bytes: 1, _id: 1 });
// only boards being erased are in the index, so it stays tiny; without it the sweep would read every board's drawing
boardSchema.index({ purgingAt: 1 }, { partialFilterExpression: { purgingAt: { $type: "date" } } });

type BoardFields = Omit<InferSchemaType<typeof boardSchema>, "elements"> & { elements: Element[] };

export const Board = mongoose.model<BoardFields, Model<BoardFields>>("Board", boardSchema);
