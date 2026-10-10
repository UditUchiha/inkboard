import { IMAGE_MAX_BYTES, IMAGE_MAX_SIDE, IMAGE_SMALL_MAX_BYTES, IMAGE_SMALL_MAX_SIDE } from "@inkboard/shared/limits";
import mongoose from "mongoose";
import { keyedQueue } from "../lib/keyed-queue.js";
import { Board } from "../models/board.model.js";
import { User } from "../models/user.model.js";
import { Version } from "../models/version.model.js";
import { getSession } from "../realtime/sessions.js";
import { emailConfigured } from "./email.js";
import { deleteImages, imageBytes, listImages, putImage } from "./image-storage.js";

// Rules for uploaded images. The browser shrinks pictures before sending them
// (to about 2000 px on the long side), so the size limit is a backstop for
// anyone who skips the app and talks to the server directly.
//
// The free database holds 512 MB for everything, so images are kept small and
// space is budgeted three ways: per board, per account (all the boards someone
// owns, whoever added the pictures), and for the whole app. Tests lower these.
export const IMAGE_LIMITS = {
  image: IMAGE_MAX_BYTES,
  small: IMAGE_SMALL_MAX_BYTES, // the small copy thumbnails draw from
  board: 25_000_000,
  owner: 100_000_000,
  // What an account whose email address nobody has confirmed can hold (only when email is set up, as for invites):
  // free accounts cost nothing to make, so they get a small share until the address is shown to be real.
  unverifiedOwner: 20_000_000,
  total: 300_000_000,
  // An image nothing shows any more is kept this long after upload, so it can
  // still be placed on the board, or brought back by undo, before it's swept.
  keepUnusedForMs: 60 * 60 * 1000,
  // Pixels on the longer side: a small file can still be a picture of billions of pixels
  // that every viewer's browser has to decode.
  side: IMAGE_MAX_SIDE,
  smallSide: IMAGE_SMALL_MAX_SIDE,
  // Uploads one account (or, for guests, one board) can make a minute.
  uploadsPerMinute: 30,
  // Uploads one network address can make a minute, for however many accounts and guests are behind it.
  uploadsPerMinutePerAddress: 90,
  // Making room by sweeping scans every version of the boards involved, so each scope (an owner's boards, or
  // the whole app) is swept at most this often.
  sweepEveryMs: 30_000,
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

// A JPEG is a run of segments; the one that starts a frame (SOF0 to SOF15, except the three that
// aren't frames) says how big the picture is.
function jpegSize(buffer) {
  let at = 2;
  while (at + 4 <= buffer.length) {
    if (buffer[at] !== 0xff) return null;
    const marker = buffer[at + 1];
    if (marker === 0xff)
      at += 1; // padding
    else if (marker === 0x01 || (marker >= 0xd0 && marker <= 0xd8))
      at += 2; // no length
    else if (marker >= 0xc0 && marker <= 0xcf && ![0xc4, 0xc8, 0xcc].includes(marker)) {
      return at + 9 <= buffer.length
        ? { width: buffer.readUInt16BE(at + 7), height: buffer.readUInt16BE(at + 5) }
        : null;
    } else at += 2 + buffer.readUInt16BE(at + 2);
  }
  return null;
}

// A WebP starts with one chunk that says how big the picture is, in one of three layouts.
function webpSize(buffer) {
  const kind = buffer.toString("latin1", 12, 16);
  if (kind === "VP8X" && buffer.length >= 30) {
    return { width: 1 + buffer.readUIntLE(24, 3), height: 1 + buffer.readUIntLE(27, 3) };
  }
  if (kind === "VP8L" && buffer.length >= 25 && buffer[20] === 0x2f) {
    return {
      width: 1 + (buffer[21] | ((buffer[22] & 0x3f) << 8)),
      height: 1 + ((buffer[22] >> 6) | (buffer[23] << 2) | ((buffer[24] & 0x0f) << 10)),
    };
  }
  if (kind === "VP8 " && buffer.length >= 30 && startsWith(buffer, [0x9d, 0x01, 0x2a], 23)) {
    return { width: buffer.readUInt16LE(26) & 0x3fff, height: buffer.readUInt16LE(28) & 0x3fff };
  }
  return null;
}

/**
 * How many pixels wide and high an image says it is, read from its header (so without
 * decoding it), or null if the header doesn't say. `mime` is what detectImageType returned.
 */
export function imageSize(buffer, mime) {
  if (mime === "image/png" && buffer.length >= 24) {
    return { width: buffer.readUInt32BE(16), height: buffer.readUInt32BE(20) };
  }
  if (mime === "image/gif" && buffer.length >= 10) {
    return { width: buffer.readUInt16LE(6), height: buffer.readUInt16LE(8) };
  }
  if (mime === "image/jpeg") return jpegSize(buffer);
  if (mime === "image/webp") return webpSize(buffer);
  return null;
}

// Why an image's size rules it out (a sentence for whoever uploaded it), or null if it's fine.
function sizeProblem(buffer, mime, side) {
  const size = imageSize(buffer, mime);
  if (!size || size.width === 0 || size.height === 0) return "That picture couldn't be read.";
  if (size.width > side || size.height > side) {
    return `That picture is too large (${size.width} by ${size.height} pixels). Use one no more than ${side} pixels on a side.`;
  }
  return null;
}

// Each upload is checked against the space left and then stored, which has to happen for one
// owner at a time, so two arriving together can't both pass a check that only one of them fits in.
// Different owners don't wait for each other (so together they can overshoot the app-wide limit by
// a few uploads at most), and a stuck write only holds up its own owner.
const uploading = keyedQueue();

// Uploads of the last minute for each account (or board, for guests) and each network address, to slow down floods.
const recentUploads = new Map();
function uploadingTooFast(key, limit) {
  const now = Date.now();
  if (recentUploads.size > 1000) {
    for (const [other, times] of recentUploads) if (now - times.at(-1) >= 60_000) recentUploads.delete(other);
  }
  const recent = (recentUploads.get(key) ?? []).filter((at) => now - at < 60_000);
  recent.push(now);
  recentUploads.set(key, recent);
  return recent.length > limit;
}

/** Forgets who uploaded lately (tests start each case from a clean slate). */
export const forgetRecentUploads = () => recentUploads.clear();

// Says so (at most once an hour) when the app's image space is getting close to full, so someone can act before it is.
let lastFullnessWarning = 0;
function warnIfNearlyFull(total) {
  if (total < IMAGE_LIMITS.total * 0.8 || Date.now() - lastFullnessWarning < 60 * 60 * 1000) return;
  lastFullnessWarning = Date.now();
  console.warn(`Image storage is ${Math.round((total / IMAGE_LIMITS.total) * 100)}% full.`);
}

// Which limit, if any, `bytes` more would break: "board", "owner" or "total".
async function limitBroken(boardId, ownerBoards, ownerLimit, bytes) {
  if ((await imageBytes({ boards: [boardId] })) + bytes > IMAGE_LIMITS.board) return "board";
  if ((await imageBytes({ boards: ownerBoards })) + bytes > ownerLimit) return "owner";
  const total = await imageBytes();
  if (total + bytes > IMAGE_LIMITS.total) return "total";
  warnIfNearlyFull(total);
  return null;
}

// Starts a sweep of a scope in the background, unless it was swept lately, so a board full of
// pictures that are all in use doesn't make every upload start a sweep that finds nothing. The
// upload that ran out of room doesn't wait for it (a sweep can take a while and would hold up
// everyone uploading to that owner's boards); trying again a moment later finds the room it made.
// Sweeps of one scope run one after another.
const lastSweep = new Map();
const sweeping = keyedQueue();
const running = new Set();
function sweepSoon(scope, filter) {
  if (Date.now() - (lastSweep.get(scope) ?? 0) < IMAGE_LIMITS.sweepEveryMs) return;
  lastSweep.set(scope, Date.now());
  const sweep = sweeping(scope, () => sweepUnusedImages(filter))
    .catch((error) => console.error(`Image cleanup failed: ${error.message}`))
    .finally(() => running.delete(sweep));
  running.add(sweep);
}

/** Resolves once the sweeps uploads have started are done (for tests). */
export const sweepsSettled = () => Promise.all([...running]);

/**
 * Stores an image (with its small copy `{ buffer, mime }`, if any) for a board if there is room. Resolves with `{ id }`, with
 * `{ full }` naming the limit it would break, `{ missing }` if the board is gone, or `{ refused }` with the reason
 * (a sentence) if the uploader or the picture is turned away: too many pictures lately, or one that can't be read or
 * is too many pixels across (a small copy that is, is just dropped). `full: "owner"` comes with `unverified: true` when
 * the owner's smaller allowance, for an unconfirmed email address, is what ran out. When there's no room, a sweep of
 * images nothing shows any more starts in the background, so removing pictures frees space for the next try.
 * `address` is where the upload came from.
 */
export async function storeImage({ boardId, buffer, mime, uploadedBy, small, address }) {
  const tooFast =
    (address && uploadingTooFast(`address:${address}`, IMAGE_LIMITS.uploadsPerMinutePerAddress)) ||
    uploadingTooFast(uploadedBy ? `user:${uploadedBy}` : `board:${boardId}`, IMAGE_LIMITS.uploadsPerMinute);
  if (tooFast) {
    return { refused: "You're adding pictures too quickly. Wait a moment and try again." };
  }
  const problem = sizeProblem(buffer, mime, IMAGE_LIMITS.side);
  if (problem) return { refused: problem };
  if (small && sizeProblem(small.buffer, small.mime, IMAGE_LIMITS.smallSide)) small = null;

  const board = await Board.findById(boardId).select("owner").lean();
  if (!board) return { missing: true };
  return uploading(String(board.owner), async () => {
    const ownerBoards = (await Board.find({ owner: board.owner }).distinct("_id")).map(String);
    const unverified =
      emailConfigured() && !(await User.findById(board.owner).select("emailVerified").lean())?.emailVerified;
    const ownerLimit = unverified ? IMAGE_LIMITS.unverifiedOwner : IMAGE_LIMITS.owner;

    const bytes = buffer.length + (small?.buffer.length ?? 0);
    const full = await limitBroken(boardId, ownerBoards, ownerLimit, bytes);
    if (full) {
      const everyone = full === "total";
      sweepSoon(everyone ? "everyone" : String(board.owner), { boards: everyone ? undefined : ownerBoards });
      return { full, ...(full === "owner" && unverified && { unverified }) };
    }
    return { id: await putImage({ board: boardId, buffer, mime, uploadedBy, small }) };
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
