import mongoose from "mongoose";

const { ObjectId, Mixed } = mongoose.Schema.Types;

const templateSchema = new mongoose.Schema(
  {
    owner: { type: ObjectId, ref: "User", required: true, index: true },
    title: { type: String, required: true, trim: true, maxlength: 60 },
    elements: { type: [Mixed], default: [] },
    // What the New board dialog shows, so listing templates doesn't send every drawing:
    // how many elements there are, and a slimmed-down copy to draw (see services/previews.js).
    // Null on templates saved before these existed; they're filled in when first listed.
    elementCount: { type: Number, default: null },
    preview: { type: Mixed, default: null },
    // Size of `elements` as MongoDB stores them, which counts towards the owner's space (see
    // ownerBytes in services/boards.js). Null on templates saved before it was, until they're measured.
    bytes: { type: Number, default: null },
  },
  { timestamps: true, minimize: false },
);

// Adding up an owner's space reads only this index, not the templates.
templateSchema.index({ owner: 1, bytes: 1 });

export const Template = mongoose.model("Template", templateSchema);
