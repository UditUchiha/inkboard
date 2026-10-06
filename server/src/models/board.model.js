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
    // People who starred the board on their dashboard.
    starredBy: [{ type: ObjectId, ref: "User", index: true }],
    // Set when the owner moves the board to the trash; it's deleted for good 30 days later.
    deletedAt: { type: Date, default: null, index: true },
  },
  { timestamps: true, minimize: false },
);

export const Board = mongoose.model("Board", boardSchema);
