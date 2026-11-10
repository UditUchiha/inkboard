import mongoose from "mongoose";
import type { InferSchemaType, Model } from "mongoose";
import type { Element } from "@inkboard/shared/types";

const { ObjectId, Mixed } = mongoose.Schema.Types;

const templateSchema = new mongoose.Schema(
  {
    owner: { type: ObjectId, ref: "User", required: true, index: true },
    title: { type: String, required: true, trim: true, maxlength: 60 },
    elements: { type: [Mixed], default: [] },
    // what the New board dialog shows, so listing templates doesn't send every drawing: the element count and a slimmed
    // copy (see services/previews.ts); filled in when first listed on older templates
    elementCount: { type: Number, default: null },
    preview: { type: Mixed, default: null },
    // as MongoDB stores it; counts towards the owner's space (see ownerBytes); null until measured on older templates
    bytes: { type: Number, default: null },
  },
  { timestamps: true, minimize: false },
);

templateSchema.index({ owner: 1, bytes: 1 });

type TemplateFields = Omit<InferSchemaType<typeof templateSchema>, "elements"> & { elements: Element[] };

export const Template = mongoose.model<TemplateFields, Model<TemplateFields>>("Template", templateSchema);
