import { randomBytes } from "node:crypto";
import { Readable } from "node:stream";
import { IMAGE_ID } from "@inkboard/shared/element-rules";
import mongoose from "mongoose";
import type { ObjectIdLike } from "./boards.ts";

// Where uploaded images live. Everything else talks to the functions in this
// file, so moving to Cloudflare R2 or Cloudinary later means rewriting this one
// file (see docs/image-storage.md). Today the files are kept in MongoDB itself,
// using GridFS: each image is cut into 255 KB chunks stored as ordinary
// documents in the `images.files` and `images.chunks` collections.
//
// Each image can also have a small copy (about 400 px) that thumbnails draw
// from, stored under "<id>.small". It goes wherever its image goes.
//
// An image's id is 128 random bits. Anyone who can see a board gets the ids in
// its elements and can fetch the image; nobody can guess an id they weren't given.

const BUCKET = "images";

/** An image's bytes with the type they were detected as. */
export interface ImageContent {
  buffer: Buffer;
  mime: string;
}

/** What is stored beside each image: the board it belongs to, who added it, and, for a small copy, the image it is of. */
interface ImageMetadata {
  board: string;
  mime: string;
  uploadedBy: ObjectIdLike | null;
  of?: string;
}

/** A document of the `images.files` collection, which GridFS keeps for each stored file. */
interface ImageFile {
  _id: mongoose.Types.ObjectId;
  filename: string;
  length: number;
  uploadDate: Date;
  metadata?: ImageMetadata;
}

/** Narrows images to some boards' (all boards' if `boards` is left out) and to those uploaded before a moment. */
export interface ImageFilter {
  boards?: readonly ObjectIdLike[];
  uploadedBefore?: Date;
}

let bucket: mongoose.mongo.GridFSBucket | undefined;
let bucketDb: mongoose.mongo.Db | undefined;

function getBucket() {
  // The connection is open by the time anyone stores or reads an image, which the type can't know.
  const db = mongoose.connection.db!;
  if (!bucket || bucketDb !== db) {
    bucket = new mongoose.mongo.GridFSBucket(db, { bucketName: BUCKET });
    bucketDb = db;
    // Looking images up by board (for the space limits and for cleanup) needs this.
    files()
      .createIndex({ "metadata.board": 1 })
      .catch(() => {});
  }
  return bucket;
}

// Open by the time anyone stores or reads an image, as in getBucket.
const files = () => mongoose.connection.db!.collection<ImageFile>(`${BUCKET}.files`);

const smallName = (id: string) => `${id}.small`;

// Narrows a query to some boards' images (all images when `boards` is left out),
// and to those uploaded before a moment. Small copies count towards space used
// but aren't listed: they belong to their image.
function matching({ boards, uploadedBefore }: ImageFilter = {}, { withSmall = false }: { withSmall?: boolean } = {}) {
  const query: {
    "metadata.of"?: { $exists: boolean };
    "metadata.board"?: { $in: string[] };
    uploadDate?: { $lt: Date };
  } = withSmall ? {} : { "metadata.of": { $exists: false } };
  if (boards) query["metadata.board"] = { $in: boards.map(String) };
  if (uploadedBefore) query.uploadDate = { $lt: uploadedBefore };
  return query;
}

// A write that hangs would otherwise hold up everything waiting behind it.
const WRITE_TIMEOUT_MS = 30_000;

function write(filename: string, buffer: Buffer, metadata: ImageMetadata) {
  return new Promise<void>((resolve, reject) => {
    const upload = getBucket().openUploadStream(filename, { metadata });
    const timer = setTimeout(() => {
      Promise.resolve(upload.abort()).catch(() => {});
      reject(new Error("Saving the image took too long."));
    }, WRITE_TIMEOUT_MS);
    upload.once("error", (error: Error) => {
      clearTimeout(timer);
      reject(error);
    });
    upload.once("finish", () => {
      clearTimeout(timer);
      resolve();
    });
    Readable.from([buffer]).pipe(upload);
  });
}

/** What putImage stores: the image, who added it and, if there is one, its small copy. */
export interface PutImage extends ImageContent {
  board: ObjectIdLike;
  uploadedBy?: ObjectIdLike | null;
  small?: ImageContent | null;
}

/** Stores an image, and its small copy `{ buffer, mime }` if given, and returns its id. */
export async function putImage({ board, buffer, mime, uploadedBy, small }: PutImage) {
  const id = randomBytes(16).toString("hex");
  const metadata = { board: String(board), mime, uploadedBy: uploadedBy ?? null };
  await write(id, buffer, metadata);
  if (small) {
    try {
      await write(smallName(id), small.buffer, { ...metadata, mime: small.mime, of: id });
    } catch (error) {
      // Nobody was given this id, so the image would sit there for good.
      await deleteImages([id]);
      throw error;
    }
  }
  return id;
}

/**
 * `{ stream, mime, size }` for an image, or null if there is no such image.
 * `small` asks for its small copy, and gets the image itself when it has none.
 */
export async function openImage(id: string, { small = false }: { small?: boolean } = {}) {
  if (!IMAGE_ID.test(id)) return null;
  const file =
    (small && (await files().findOne({ filename: smallName(id) }))) || (await files().findOne({ filename: id }));
  if (!file) return null;
  return { stream: getBucket().openDownloadStream(file._id), mime: file.metadata?.mime, size: file.length };
}

/** Bytes of images held by some boards, or by every board when `boards` is left out. */
export async function imageBytes({ boards }: Pick<ImageFilter, "boards"> = {}) {
  const [total] = await files()
    .aggregate<{ bytes: number }>([
      { $match: matching({ boards }, { withSmall: true }) },
      { $group: { _id: null, bytes: { $sum: "$length" } } },
    ])
    .toArray();
  return total?.bytes ?? 0;
}

/** `[{ id, board }]` for images matching `{ boards, uploadedBefore }` (both optional). */
export async function listImages(filter?: ImageFilter) {
  const found = await files()
    .find(matching(filter), { projection: { filename: 1, "metadata.board": 1 } })
    .toArray();
  return found.map((file) => ({ id: file.filename, board: file.metadata?.board }));
}

/** Deletes images by id, with their small copies. */
export async function deleteImages(ids: string[]) {
  if (ids.length === 0) return;
  const found = await files()
    .find({ filename: { $in: [...ids, ...ids.map(smallName)] } }, { projection: { _id: 1 } })
    .toArray();
  for (const file of found) {
    try {
      await getBucket().delete(file._id);
    } catch (error) {
      // Keep going: the rest should still go, and a sweep finds what's left.
      // Whatever was thrown, a failed delete is an Error.
      console.error(`Couldn't delete a stored image: ${(error as Error).message}`);
    }
  }
}

/** Deletes every image that belongs to a board. */
export async function deleteBoardImages(board: ObjectIdLike) {
  await deleteImages((await listImages({ boards: [board] })).map((image) => image.id));
}
