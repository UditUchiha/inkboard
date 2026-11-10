import mongoose from "mongoose";

const { ObjectId } = mongoose.Schema.Types;

// Per person, so archiving never affects the others a board is shared with. Opening a board shared by link creates a
// record, which is what puts it on that person's dashboard. (Stars live on the board, the trash is the owner's.)
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
