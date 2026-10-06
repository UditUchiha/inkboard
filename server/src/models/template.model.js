import mongoose from "mongoose";

const { ObjectId, Mixed } = mongoose.Schema.Types;

const templateSchema = new mongoose.Schema(
  {
    owner: { type: ObjectId, ref: "User", required: true, index: true },
    title: { type: String, required: true, trim: true, maxlength: 60 },
    elements: { type: [Mixed], default: [] },
  },
  { timestamps: true, minimize: false },
);

export const Template = mongoose.model("Template", templateSchema);
