import mongoose from "mongoose";
import type { InferSchemaType, Model } from "mongoose";
import type { Element } from "@inkboard/shared/types";

const { ObjectId, Mixed } = mongoose.Schema.Types;

// "auto": taken while people draw. "named": saved by someone on purpose.
// "restore": the state just before an older version was restored.
export const VERSION_KINDS = ["auto", "named", "restore"];

const versionSchema = new mongoose.Schema(
  {
    board: { type: ObjectId, ref: "Board", required: true },
    kind: { type: String, enum: VERSION_KINDS, default: "auto" },
    label: { type: String, trim: true, maxlength: 60, default: null },
    author: { type: ObjectId, ref: "User", default: null },
    elements: { type: [Mixed], default: [] },
    elementCount: { type: Number, default: 0 },
    // Size of the copy as MongoDB stores it, for the history's budget (see services/versions.js).
    // Null for versions saved before sizes were recorded, until they're measured.
    bytes: { type: Number, default: null },
  },
  { timestamps: { createdAt: true, updatedAt: false }, minimize: false },
);

versionSchema.index({ board: 1, createdAt: -1 });
// Adding up the space a board's saved versions (or an owner's boards') take reads only this index.
versionSchema.index({ board: 1, kind: 1, bytes: 1 });

// Mongoose can only infer `elements` as `any[]` from Mixed, so the type says what is stored in it.
type VersionFields = Omit<InferSchemaType<typeof versionSchema>, "elements"> & { elements: Element[] };

export const Version = mongoose.model<VersionFields, Model<VersionFields>>("Version", versionSchema);
