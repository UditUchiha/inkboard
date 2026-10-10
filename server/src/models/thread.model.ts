import mongoose from "mongoose";

const { ObjectId } = mongoose.Schema.Types;

const messageSchema = new mongoose.Schema(
  {
    author: { type: ObjectId, ref: "User", required: true },
    body: { type: String, required: true, trim: true, maxlength: 2000 },
    mentions: [{ type: ObjectId, ref: "User" }],
  },
  { timestamps: { createdAt: true, updatedAt: false } },
);

// A comment thread pinned to a point on a board's canvas.
const threadSchema = new mongoose.Schema(
  {
    board: { type: ObjectId, ref: "Board", required: true, index: true },
    author: { type: ObjectId, ref: "User", required: true },
    x: { type: Number, required: true },
    y: { type: Number, required: true },
    resolved: { type: Boolean, default: false },
    messages: { type: [messageSchema], default: [] },
  },
  { timestamps: true },
);

export const Thread = mongoose.model("Thread", threadSchema);
