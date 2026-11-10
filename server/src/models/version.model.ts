import mongoose from "mongoose";
import type { InferSchemaType, Model } from "mongoose";
import type { Element } from "@inkboard/shared/types";

const { ObjectId, Mixed } = mongoose.Schema.Types;

// "auto": taken while people draw; "named": saved on purpose; "restore": the state just before an older version was
// restored
export const VERSION_KINDS = ["auto", "named", "restore"];

const versionSchema = new mongoose.Schema(
  {
    board: { type: ObjectId, ref: "Board", required: true },
    kind: { type: String, enum: VERSION_KINDS, default: "auto" },
    label: { type: String, trim: true, maxlength: 60, default: null },
    author: { type: ObjectId, ref: "User", default: null },
    // versions saved before compression keep their elements here; newer ones leave it empty
    elements: { type: [Mixed], default: [] },
    packed: { type: Buffer, default: null },
    // so finding the images still in use doesn't unpack every version
    imageIds: { type: [String], default: undefined },
    elementCount: { type: Number, default: 0 },
    // as MongoDB stores it, for the history's budget (see services/versions.ts); null until measured on older versions
    bytes: { type: Number, default: null },
  },
  { timestamps: { createdAt: true, updatedAt: false }, minimize: false },
);

versionSchema.index({ board: 1, createdAt: -1 });
versionSchema.index({ board: 1, kind: 1, bytes: 1 });
// Mixed infers `elements` as `any[]`, so the type says what is stored
type VersionFields = Omit<InferSchemaType<typeof versionSchema>, "elements"> & { elements: Element[] };

export const Version = mongoose.model<VersionFields, Model<VersionFields>>("Version", versionSchema);
