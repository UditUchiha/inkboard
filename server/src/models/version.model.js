import mongoose from "mongoose";

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

export const Version = mongoose.model("Version", versionSchema);
