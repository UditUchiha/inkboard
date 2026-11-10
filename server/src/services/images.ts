import type { Element } from "@inkboard/shared/types";
import { IMAGE_MAX_BYTES, IMAGE_MAX_SIDE, IMAGE_SMALL_MAX_BYTES, IMAGE_SMALL_MAX_SIDE } from "@inkboard/shared/limits";
import type { ImageUsage } from "@inkboard/shared/api";
import type { ImageLimit } from "@inkboard/shared/socket";
import mongoose from "mongoose";
import { keyedQueue } from "../lib/keyed-queue.ts";
import { Board } from "../models/board.model.ts";
import { User } from "../models/user.model.ts";
import { Version } from "../models/version.model.ts";
import { getSession } from "../realtime/sessions.ts";
import { env } from "../config/env.ts";
import { emailConfigured } from "./email.ts";
import type { ObjectIdLike } from "./boards.ts";
import {
  copyImages,
  deleteImages,
  imageBytes,
  imageBytesAmong,
  imageBytesByBoard,
  listImages,
  putImage,
} from "./image-storage.ts";
import type { CopyImages, ImageContent, ImageFilter } from "./image-storage.ts";

// The browser shrinks pictures before sending, so the size limit is a backstop for anyone talking to the server
// directly. The free database holds 512 MB for everything, so space is budgeted per board, per account (all boards
// someone owns, whoever added the pictures) and for the whole app. Tests lower these.
export const IMAGE_LIMITS = {
  image: IMAGE_MAX_BYTES,
  small: IMAGE_SMALL_MAX_BYTES, // the small copy thumbnails draw from
  board: 25_000_000,
  owner: 100_000_000,
  // free accounts cost nothing to make, so an unconfirmed address (only when email is set up) gets a small share
  unverifiedOwner: 20_000_000,
  // images in R2 (see image-storage.ts) don't take database space
  total: env.r2 ? 9_000_000_000 : 300_000_000,
  // kept this long after upload so it can still be placed, or brought back by undo, before it's swept
  keepUnusedForMs: 60 * 60 * 1000,
  // a small file can still be a picture of billions of pixels that every viewer's browser has to decode
  side: IMAGE_MAX_SIDE,
  smallSide: IMAGE_SMALL_MAX_SIDE,
  uploadsPerMinute: 30,
  uploadsPerMinutePerAddress: 90,
  // sweeping scans every version of the boards involved, so each scope is swept at most this often
  sweepEveryMs: 30_000,
};

const SWEEP_INTERVAL_MS = 6 * 3600 * 1000;

export type ImageMime = "image/png" | "image/jpeg" | "image/gif" | "image/webp";

export interface ImageSize {
  width: number;
  height: number;
}

const startsWith = (buffer: Buffer, bytes: number[], offset = 0) =>
  bytes.every((byte, index) => buffer[offset + index] === byte);

// Judged by the first bytes, not what the sender claims. SVG is left out on purpose: it can carry scripts.
export function detectImageType(buffer: unknown): ImageMime | null {
  if (!Buffer.isBuffer(buffer) || buffer.length < 12) return null;
  if (startsWith(buffer, [0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a])) return "image/png";
  if (startsWith(buffer, [0xff, 0xd8, 0xff])) return "image/jpeg";
  if (startsWith(buffer, [0x47, 0x49, 0x46, 0x38]) && (buffer[4] === 0x37 || buffer[4] === 0x39)) return "image/gif";
  if (startsWith(buffer, [0x52, 0x49, 0x46, 0x46]) && startsWith(buffer, [0x57, 0x45, 0x42, 0x50], 8)) {
    return "image/webp";
  }
  return null;
}

// the segment that starts a frame (SOF0 to SOF15, except the three that aren't frames) says how big the picture is
function jpegSize(buffer: Buffer): ImageSize | null {
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

// the first chunk says how big the picture is, in one of three layouts
function webpSize(buffer: Buffer): ImageSize | null {
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

// read from the header, without decoding
export function imageSize(buffer: Buffer, mime: string): ImageSize | null {
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

function sizeProblem(buffer: Buffer, mime: string, side: number) {
  const size = imageSize(buffer, mime);
  if (!size || size.width === 0 || size.height === 0) return "That picture couldn't be read.";
  if (size.width > side || size.height > side) {
    return `That picture is too large (${size.width} by ${size.height} pixels). Use one no more than ${side} pixels on a side.`;
  }
  return null;
}

// Checked against the space left and then stored, one owner at a time, so two arriving together can't both pass a check
// that only one fits. Different owners don't wait for each other (they can overshoot the app-wide limit by a few
// uploads).
const uploading = keyedQueue();

// last minute's uploads per account (board, for guests) and per network address, to slow down floods
const recentUploads = new Map<string, number[]>();
function uploadingTooFast(key: string, limit: number) {
  const now = Date.now();
  if (recentUploads.size > 1000) {
    for (const [other, times] of recentUploads) if (now - times.at(-1)! >= 60_000) recentUploads.delete(other);
  }
  const recent = (recentUploads.get(key) ?? []).filter((at) => now - at < 60_000);
  recent.push(now);
  recentUploads.set(key, recent);
  return recent.length > limit;
}

export const forgetRecentUploads = () => recentUploads.clear();

// at most once an hour, so someone can act before the space runs out
let lastFullnessWarning = 0;
function warnIfNearlyFull(total: number) {
  if (total < IMAGE_LIMITS.total * 0.8 || Date.now() - lastFullnessWarning < 60 * 60 * 1000) return;
  lastFullnessWarning = Date.now();
  console.warn(`Image storage is ${Math.round((total / IMAGE_LIMITS.total) * 100)}% full.`);
}

export type { ImageLimit };

async function limitBroken(
  boardId: ObjectIdLike,
  ownerBoards: string[],
  ownerLimit: number,
  bytes: number,
): Promise<ImageLimit | null> {
  if ((await imageBytes({ boards: [boardId] })) + bytes > IMAGE_LIMITS.board) return "board";
  if ((await imageBytes({ boards: ownerBoards })) + bytes > ownerLimit) return "owner";
  const total = await imageBytes();
  if (total + bytes > IMAGE_LIMITS.total) return "total";
  warnIfNearlyFull(total);
  return null;
}

// A background sweep, unless the scope was swept lately, so a board full of pictures in use doesn't start a pointless
// sweep per upload. The upload that ran out of room doesn't wait (a sweep would hold up everyone uploading to that
// owner); a retry a moment later finds the room. Sweeps of one scope run one after another.
const lastSweep = new Map<string, number>();
const sweeping = keyedQueue();
const running = new Set<Promise<unknown>>();
function sweepSoon(scope: string, filter: ImageFilter) {
  if (Date.now() - (lastSweep.get(scope) ?? 0) < IMAGE_LIMITS.sweepEveryMs) return;
  lastSweep.set(scope, Date.now());
  const sweep: Promise<unknown> = sweeping(scope, () => sweepUnusedImages(filter))
    .catch((error: Error) => console.error(`Image cleanup failed: ${error.message}`))
    .finally(() => running.delete(sweep));
  running.add(sweep);
}

export const sweepsSettled = () => Promise.all([...running]);

export interface StoreImage extends ImageContent {
  boardId: ObjectIdLike;
  uploadedBy?: ObjectIdLike | null;
  small?: ImageContent | null;
  address?: string;
}

export type StoreResult =
  { id: string } | { full: ImageLimit; unverified?: true } | { missing: true } | { refused: string };

// `{ full }` names the limit it would break (with `unverified: true` when the owner's smaller allowance for an
// unconfirmed address ran out); `{ refused }` is a sentence for a turned-away uploader or picture (too many lately,
// unreadable, too many pixels; a small copy that is, is just dropped). When there's no room a sweep starts in the
// background, so removing pictures frees space for the next try.
export async function storeImage({
  boardId,
  buffer,
  mime,
  uploadedBy,
  small,
  address,
}: StoreImage): Promise<StoreResult> {
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
    const full = await roomFor(boardId, board.owner, buffer.length + (small?.buffer.length ?? 0));
    return full ?? { id: await putImage({ board: boardId, buffer, mime, uploadedBy, small }) };
  });
}

// Null if they fit, else `{ full }` naming the limit; then a sweep starts (see sweepSoon). Run in `uploading`.
async function roomFor(boardId: ObjectIdLike, owner: ObjectIdLike, bytes: number) {
  const ownerBoards = (await Board.find({ owner }).distinct("_id")).map(String);
  const { limit: ownerLimit, unverified } = await ownerImageLimit(owner);
  const full = await limitBroken(boardId, ownerBoards, ownerLimit, bytes);
  if (!full) return null;
  const everyone = full === "total";
  sweepSoon(everyone ? "everyone" : String(owner), { boards: everyone ? undefined : ownerBoards });
  return { full, ...(full === "owner" && unverified && { unverified: true as const }) };
}

async function ownerImageLimit(owner: ObjectIdLike) {
  const unverified = emailConfigured() && !(await User.findById(owner).select("emailVerified").lean())?.emailVerified;
  return { limit: unverified ? IMAGE_LIMITS.unverifiedOwner : IMAGE_LIMITS.owner, unverified };
}

// trashed boards too until erased; pictures taken off a board count until a sweep removes them
export async function ownerImageUsage(owner: ObjectIdLike): Promise<ImageUsage> {
  const boards = await Board.find({ owner }).select("title deletedAt").lean();
  const bytes = await imageBytesByBoard(boards.map((board) => board._id));
  const { limit, unverified } = await ownerImageLimit(owner);
  const used = [...bytes.values()].reduce((sum, size) => sum + size, 0);
  const holding = boards
    .filter((board) => bytes.has(String(board._id)))
    .map((board) => ({
      id: String(board._id),
      title: board.title,
      bytes: bytes.get(String(board._id))!,
      trashed: Boolean(board.deletedAt),
    }))
    .sort((a, b) => b.bytes - a.bytes);
  return { used, limit, boardLimit: IMAGE_LIMITS.board, unverified, boards: holding };
}

// for a copy of a board (see copyImages); resolves with the copies' ids by the originals', or `{ full }`
export async function copyBoardImages({ owner, ...copy }: CopyImages & { owner: ObjectIdLike }) {
  return uploading(String(owner), async () => {
    const full = await roomFor(copy.to, owner, await imageBytesAmong(copy.from, copy.ids));
    return full ?? { copies: await copyImages(copy) };
  });
}

const imageIdsIn = async (
  Model: Pick<mongoose.Model<unknown>, "aggregate">,
  match: Record<string, mongoose.Types.ObjectId>,
) =>
  (
    await Model.aggregate<{ _id: string }>([
      { $match: match },
      { $unwind: "$elements" },
      { $match: { "elements.type": "image" } },
      { $group: { _id: "$elements.imageId" } },
    ])
  ).map((row) => row._id);

// on the board itself (as people see it now, if it's open) or in any saved version, which can be restored
async function imagesShownBy(boardId: string | undefined) {
  if (!mongoose.isValidObjectId(boardId)) return new Set();
  const _id = new mongoose.Types.ObjectId(String(boardId));
  const live: Element[] | undefined = getSession(String(boardId))?.elements;
  const onBoard = live
    ? live.filter((element) => element.type === "image").map((element) => element.imageId)
    : await imageIdsIn(Board, { _id });
  // versions saved before compression show theirs in their elements; newer ones list them
  const inVersions = [
    ...(await imageIdsIn(Version, { board: _id })),
    ...(await Version.distinct("imageIds", { board: _id })),
  ];
  return new Set([...onBoard, ...inVersions]);
}

// Limited to `boards` when given. Resolves with how many were deleted.
export async function sweepUnusedImages({
  boards,
  uploadedBefore = new Date(Date.now() - IMAGE_LIMITS.keepUnusedForMs),
}: ImageFilter = {}) {
  const byBoard = new Map<string | undefined, string[]>();
  for (const image of await listImages({ boards, uploadedBefore })) {
    byBoard.set(image.board, [...(byBoard.get(image.board) ?? []), image.id]);
  }
  const unused: string[] = [];
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
      .catch((error: Error) => console.error(`Image cleanup failed: ${error.message}`));
  sweep();
  return setInterval(sweep, SWEEP_INTERVAL_MS).unref();
}
