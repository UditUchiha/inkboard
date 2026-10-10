import { Board } from "../models/board.model.js";
import { destroyBoard } from "./boards.js";

// How long a deleted board stays in the trash before it's erased for good.
export const TRASH_DAYS = 30;

const SWEEP_INTERVAL_MS = 6 * 3600 * 1000;

// Boards to erase now: trashed before `cutoff`, or already being erased (see destroyBoard). Each
// branch is answered from an index (deletedAt's, and the partial one on purgingAt, which `$type`
// matches exactly), so the sweep doesn't read every board's drawing. Exported for the test that
// checks that.
export const expiredBoards = (cutoff) => ({
  $or: [{ deletedAt: { $ne: null, $lt: cutoff } }, { purgingAt: { $type: "date" } }],
});

/**
 * Deletes boards that have been in the trash longer than TRASH_DAYS, and finishes deleting any
 * whose deletion was cut off part-way (see destroyBoard).
 */
export async function purgeExpiredTrash() {
  const cutoff = new Date(Date.now() - TRASH_DAYS * 24 * 3600 * 1000);
  const expired = await Board.find(expiredBoards(cutoff)).select("_id");
  let purged = 0;
  // A board restored since the list was read is no longer trashed, and is left alone.
  for (const board of expired) if (await destroyBoard(board._id, { trashedBefore: cutoff })) purged += 1;
  return purged;
}

export function startTrashSweeper() {
  const sweep = () =>
    purgeExpiredTrash()
      .then((count) => count > 0 && console.log(`Deleted ${count} board(s) from the trash for good.`))
      .catch((error) => console.error(`Trash cleanup failed: ${error.message}`));
  sweep();
  return setInterval(sweep, SWEEP_INTERVAL_MS).unref();
}
