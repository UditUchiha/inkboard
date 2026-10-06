import mongoose from "mongoose";

const { ObjectId } = mongoose.Schema.Types;

// What one person has done with one board: when they last opened it and whether
// they archived it. It's per person, so archiving never affects the other people
// it's shared with. Opening a board shared by link creates a record, which is what
// makes it appear on that person's dashboard. (Stars live on the board, and the
// trash is the owner's, so neither is stored here.)
const boardStateSchema = new mongoose.Schema(
  {
    user: { type: ObjectId, ref: "User", required: true },
    board: { type: ObjectId, ref: "Board", required: true, index: true },
    lastOpenedAt: { type: Date, default: null },
    archived: { type: Boolean, default: false },
  },
  { timestamps: true },
);

boardStateSchema.index({ user: 1, board: 1 }, { unique: true });

export const BoardState = mongoose.model("BoardState", boardStateSchema);
