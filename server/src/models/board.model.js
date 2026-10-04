import mongoose from "mongoose";

const { ObjectId, Mixed } = mongoose.Schema.Types;

const boardSchema = new mongoose.Schema(
  {
    title: { type: String, trim: true, maxlength: 80, default: "Untitled board" },
    owner: { type: ObjectId, ref: "User", required: true, index: true },
    collaborators: [{ type: ObjectId, ref: "User", index: true }],
    elements: { type: [Mixed], default: [] },
  },
  { timestamps: true, minimize: false },
);

export const Board = mongoose.model("Board", boardSchema);
