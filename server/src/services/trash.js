import { TRASH_DAYS } from "../controllers/board.controller.js";
import { Board } from "../models/board.model.js";
import { destroyBoard } from "./boards.js";

const SWEEP_INTERVAL_MS = 6 * 3600 * 1000;

/** Deletes boards that have been in the trash longer than TRASH_DAYS. */
export async function purgeExpiredTrash() {
  const cutoff = new Date(Date.now() - TRASH_DAYS * 24 * 3600 * 1000);
  const expired = await Board.find({ deletedAt: { $ne: null, $lt: cutoff } }).select("_id");
  for (const board of expired) await destroyBoard(board._id);
  return expired.length;
}

export function startTrashSweeper() {
  const sweep = () =>
    purgeExpiredTrash()
      .then((count) => count > 0 && console.log(`Deleted ${count} board(s) from the trash for good.`))
      .catch((error) => console.error(`Trash cleanup failed: ${error.message}`));
  sweep();
  return setInterval(sweep, SWEEP_INTERVAL_MS).unref();
}
