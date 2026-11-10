import type { Element } from "@inkboard/shared/types";
import mongoose from "mongoose";
import type { Types } from "mongoose";
import { keyedQueue } from "../lib/keyed-queue.ts";
import { ReplayStep } from "../models/replay-step.model.ts";
import type { ObjectIdLike } from "./boards.ts";

export interface Step {
  upsert: Element[];
  remove: string[];
}

// A log of steps, each what changed in a few seconds of work (see takeStep in realtime/sessions.ts). Past `bytes` the
// oldest are folded into the first, so the replay starts from the board as it was before the recent work. Tests lower these.
export const REPLAY_LIMITS = {
  stepMs: 3000,
  bytes: 5_000_000,
};

const sizeOf = (step: Step) => mongoose.mongo.BSON.calculateObjectSize(step);

// an element changed when it's a different object, which is how sessions make every change (see commitPlan)
export function diffElements(recorded: Map<string, Element>, elements: Element[]) {
  const next = new Map(elements.map((element) => [element.id, element]));
  const upsert = elements.filter((element) => recorded.get(element.id) !== element);
  const remove = [...recorded.keys()].filter((id) => !next.has(id));
  return { step: upsert.length + remove.length > 0 ? { upsert, remove } : null, next };
}

export function mergeSteps(first: Step, second: Step): Step {
  const upsert = new Map(first.upsert.map((element) => [element.id, element]));
  const remove = new Set(first.remove);
  for (const id of second.remove) {
    upsert.delete(id);
    remove.add(id);
  }
  for (const element of second.upsert) {
    upsert.set(element.id, element);
    remove.delete(element.id);
  }
  return { upsert: [...upsert.values()], remove: [...remove] };
}

const writing = keyedQueue();

export function recordStep(boardId: ObjectIdLike, step: Step, at = new Date()) {
  return writing(String(boardId), async () => {
    await ReplayStep.create({ board: boardId, at, ...step, bytes: sizeOf(step) });
    const steps = await ReplayStep.find({ board: boardId })
      .sort({ at: 1, _id: 1 })
      .select("bytes")
      .lean<{ _id: Types.ObjectId; bytes: number }[]>();
    let total = steps.reduce((sum, { bytes }) => sum + bytes, 0);
    let folded = 1;
    while (total > REPLAY_LIMITS.bytes && folded < steps.length) total -= steps[folded++].bytes;
    if (folded === 1) return;

    const ids = steps.slice(0, folded).map(({ _id }) => _id);
    const docs = await ReplayStep.find({ _id: { $in: ids } })
      .sort({ at: 1, _id: 1 })
      .lean();
    const merged = docs.reduce<Step>((base, doc) => mergeSteps(base, doc), { upsert: [], remove: [] });
    const first = { upsert: merged.upsert, remove: [] };
    await ReplayStep.updateOne({ _id: ids[0] }, { $set: { ...first, at: docs.at(-1)!.at, bytes: sizeOf(first) } });
    await ReplayStep.deleteMany({ _id: { $in: ids.slice(1) } });
  });
}

export async function hasReplay(boardId: ObjectIdLike) {
  return Boolean(await ReplayStep.exists({ board: boardId }));
}

export async function replaySteps(boardId: ObjectIdLike) {
  const steps = await ReplayStep.find({ board: boardId }).sort({ at: 1, _id: 1 }).select("at upsert remove").lean();
  return steps.map(({ at, upsert, remove }) => ({ at: at.getTime(), upsert, remove }));
}

export function removeReplay(boardId: ObjectIdLike) {
  return writing(String(boardId), () => ReplayStep.deleteMany({ board: boardId }));
}
