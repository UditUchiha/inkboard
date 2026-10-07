import mongoose from "mongoose";
import { Board } from "../models/board.model.js";
import { Version } from "../models/version.model.js";
import { getSession } from "../realtime/sessions.js";
import { deleteImages, imageBytes, listImages, putImage } from "./image-storage.js";

// Rules for uploaded images. The browser shrinks pictures before sending them
// (to about 2000 px on the long side), so the size limit is a backstop for
// anyone who skips the app and talks to the server directly.
//
// The free database holds 512 MB for everything, so images are kept small and
// space is budgeted three ways: per board, per account (all the boards someone
// owns, whoever added the pictures), and for the whole app. Tests lower these.
export const IMAGE_LIMITS = {
  image: 2_000_000,
  board: 25_000_000,
  owner: 100_000_000,
  total: 300_000_000,
  // An image nothing shows any more is kept this long after upload, so it can
  // still be placed on the board, or brought back by undo, before it's swept.
  keepUnusedForMs: 60 * 60 * 1000,
};

const SWEEP_INTERVAL_MS = 6 * 3600 * 1000;

const startsWith = (buffer, bytes, offset = 0) => bytes.every((byte, index) => buffer[offset + index] === byte);

/**
 * What kind of image a file really is, judged by its first bytes rather than by
 * what the sender claims. Returns a MIME type, or null for anything else.
 * SVG is left out on purpose: it can carry scripts.
 */
export function detectImageType(buffer) {
  if (!Buffer.isBuffer(buffer) || buffer.length < 12) return null;
  if (startsWith(buffer, [0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a])) return "image/png";
  if (startsWith(buffer, [0xff, 0xd8, 0xff])) return "image/jpeg";
  if (startsWith(buffer, [0x47, 0x49, 0x46, 0x38]) && (buffer[4] === 0x37 || buffer[4] === 0x39)) return "image/gif";
  if (startsWith(buffer, [0x52, 0x49, 0x46, 0x46]) && startsWith(buffer, [0x57, 0x45, 0x42, 0x50], 8)) {
    return "image/webp";
  }
  return null;
}

// Uploads are handled one at a time, so two arriving together can't both pass
// a space check that only one of them fits in.
let queue = Promise.resolve();
function oneAtATime(task) {
  const run = queue.then(task, task);
  queue = run.catch(() => {});
  return run;
}

// Which limit, if any, `bytes` more would break: "board", "owner" or "total".
async function limitBroken(boardId, ownerBoards, bytes) {
  if ((await imageBytes({ boards: [boardId] })) + bytes > IMAGE_LIMITS.board) return "board";
  if ((await imageBytes({ boards: ownerBoards })) + bytes > IMAGE_LIMITS.owner) return "owner";
  if ((await imageBytes()) + bytes > IMAGE_LIMITS.total) return "total";
  return null;
}

/**
 * Stores an image for a board if there is room. Resolves with `{ id }`, with
 * `{ full }` naming the limit it would break, or `{ missing }` if the board is gone. When there's no room, images
 * nothing shows any more are swept first, so removing pictures frees space.
 */
export function storeImage({ boardId, buffer, mime, uploadedBy }) {
  return oneAtATime(async () => {
    const board = await Board.findById(boardId).select("owner").lean();
    if (!board) return { missing: true };
    const ownerBoards = (await Board.find({ owner: board.owner }).distinct("_id")).map(String);

    let full = await limitBroken(boardId, ownerBoards, buffer.length);
    if (full) {
      await sweepUnusedImages({ boards: full === "total" ? undefined : ownerBoards });
      full = await limitBroken(boardId, ownerBoards, buffer.length);
    }
    if (full) return { full };
    return { id: await putImage({ board: boardId, buffer, mime, uploadedBy }) };
  });
}

const imageIdsIn = async (Model, match) =>
  (
    await Model.aggregate([
      { $match: match },
      { $unwind: "$elements" },
      { $match: { "elements.type": "image" } },
      { $group: { _id: "$elements.imageId" } },
    ])
  ).map((row) => row._id);

// The images a board still shows: on the board itself (as people see it right
// now, if it's open) or in any of its saved versions, which can be restored.
async function imagesShownBy(boardId) {
  if (!mongoose.isValidObjectId(boardId)) return new Set();
  const _id = new mongoose.Types.ObjectId(String(boardId));
  const live = getSession(String(boardId))?.elements;
  const onBoard = live
    ? live.filter((element) => element.type === "image").map((element) => element.imageId)
    : await imageIdsIn(Board, { _id });
  return new Set([...onBoard, ...(await imageIdsIn(Version, { board: _id }))]);
}

/**
 * Deletes images that neither their board nor any of its versions shows, once
 * they're older than `keepUnusedForMs`. Limited to `boards` when given.
 * Resolves with how many were deleted.
 */
export async function sweepUnusedImages({
  boards,
  uploadedBefore = new Date(Date.now() - IMAGE_LIMITS.keepUnusedForMs),
} = {}) {
  const byBoard = new Map();
  for (const image of await listImages({ boards, uploadedBefore })) {
    byBoard.set(image.board, [...(byBoard.get(image.board) ?? []), image.id]);
  }
  const unused = [];
  for (const [boardId, ids] of byBoard) {
    const shown = await imagesShownBy(boardId);
    unused.push(...ids.filter((id) => !shown.has(id)));
  }
  await deleteImages(unused);
  return unused.length;
}

export function startImageSweeper() {
  const sweep = () =>
    sweepUnusedImages()
      .then((count) => count > 0 && console.log(`Deleted ${count} image(s) no board shows any more.`))
      .catch((error) => console.error(`Image cleanup failed: ${error.message}`));
  sweep();
  return setInterval(sweep, SWEEP_INTERVAL_MS).unref();
}
