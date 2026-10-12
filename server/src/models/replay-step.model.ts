import mongoose from "mongoose";
import type { InferSchemaType, Model } from "mongoose";
import type { Element } from "@inkboard/shared/types";

const { ObjectId, Mixed } = mongoose.Schema.Types;

// One step of a board's replay (see services/replay.ts): the elements that changed in a few seconds of work, as
// they were at its end, and the ids of those removed. A board's first step is the board as the replay starts.
const replayStepSchema = new mongoose.Schema(
  {
    board: { type: ObjectId, ref: "Board", required: true },
    at: { type: Date, required: true },
    upsert: { type: [Mixed], default: [] },
    remove: { type: [String], default: [] },
    // Size of the step as MongoDB stores it, for the replay's budget.
    bytes: { type: Number, required: true },
  },
  { minimize: false },
);

replayStepSchema.index({ board: 1, at: 1, _id: 1 });

// Mongoose can only infer `upsert` as `any[]` from Mixed, so the type says what is stored in it.
type ReplayStepFields = Omit<InferSchemaType<typeof replayStepSchema>, "upsert"> & { upsert: Element[] };

export const ReplayStep = mongoose.model<ReplayStepFields, Model<ReplayStepFields>>("ReplayStep", replayStepSchema);
