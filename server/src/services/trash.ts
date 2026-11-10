import { Board } from "../models/board.model.ts";
import { destroyBoard } from "./boards.ts";

export const TRASH_DAYS = 30;

const SWEEP_INTERVAL_MS = 6 * 3600 * 1000;

// Trashed before `cutoff`, or already being erased (see destroyBoard). Each branch is answered from an index
// (deletedAt's, and the partial one on purgingAt, which `$type` matches exactly), so the sweep doesn't read every
// drawing; exported for the test that checks that.
export const expiredBoards = (
  cutoff: Date,
): { $or: [{ deletedAt: { $ne: null; $lt: Date } }, { purgingAt: { $type: "date" } }] } => ({
  $or: [{ deletedAt: { $ne: null, $lt: cutoff } }, { purgingAt: { $type: "date" } }],
});

export async function purgeExpiredTrash() {
  const cutoff = new Date(Date.now() - TRASH_DAYS * 24 * 3600 * 1000);
  const expired = await Board.find(expiredBoards(cutoff)).select("_id");
  let purged = 0;
  // a board restored since the list was read is no longer trashed, and is left alone
  for (const board of expired) if (await destroyBoard(board._id, { trashedBefore: cutoff })) purged += 1;
  return purged;
}

export function startTrashSweeper() {
  const sweep = () =>
    purgeExpiredTrash()
      .then((count) => count > 0 && console.log(`Deleted ${count} board(s) from the trash for good.`))
      .catch((error: Error) => console.error(`Trash cleanup failed: ${error.message}`));
  sweep();
  return setInterval(sweep, SWEEP_INTERVAL_MS).unref();
}
