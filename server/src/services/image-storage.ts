import { randomBytes } from "node:crypto";
import { Readable } from "node:stream";
import type { ReadableStream as NodeReadableStream } from "node:stream/web";
import { IMAGE_ID } from "@inkboard/shared/element-rules";
import { AwsClient } from "aws4fetch";
import mongoose from "mongoose";
import type { R2Settings } from "../config/env.ts";
import type { ObjectIdLike } from "./boards.ts";

// Where uploaded images live. Everything else talks to the functions in this
// file (see docs/image-storage.md). Each image has an entry in the `images.files`
// collection (its name, size, type and board), which the space limits and sweeps
// look images up by. Its bytes are kept in one of two places:
//
// - MongoDB itself, using GridFS: cut into 255 KB chunks stored as ordinary
//   documents in `images.chunks`. Used when R2 isn't set up.
// - Cloudflare R2, once R2_* are set (see env.r2): the entry says `storage: "r2"`.
//   Images uploaded before stay in GridFS and are still served from there, until
//   scripts/move-images-to-r2.ts moves them.
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

/** A document of the `images.files` collection, which GridFS keeps for each stored file (and R2's are kept like). */
interface ImageFile {
  _id: mongoose.Types.ObjectId;
  filename: string;
  length: number;
  uploadDate: Date;
  metadata?: ImageMetadata;
  // Set when the bytes are in R2 rather than in `images.chunks`.
  storage?: "r2";
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

// R2 is S3-compatible: each file is an object under images/<name>, sent with requests signed for S3.
let r2: { settings: R2Settings; client: AwsClient } | undefined;

async function objectStore() {
  // Loaded when first needed rather than with this file, which services/boards.ts loads: tests load that before
  // they set up the environment env.ts reads when it loads.
  const { env } = await import("../config/env.ts");
  const settings = env.r2;
  if (!settings) return null;
  if (r2?.settings !== settings) {
    const { accessKeyId, secretAccessKey } = settings;
    r2 = { settings, client: new AwsClient({ accessKeyId, secretAccessKey, service: "s3", region: "auto" }) };
  }
  const { client } = r2;
  const url = (name: string) =>
    `https://${settings.accountId}.r2.cloudflarestorage.com/${settings.bucket}/images/${encodeURIComponent(name)}`;
  const send = async (name: string, init: RequestInit, ok: (status: number) => boolean) => {
    const response = await client.fetch(url(name), init);
    if (!ok(response.status)) throw new Error(`R2 answered ${response.status} to ${init.method ?? "GET"} ${name}.`);
    return response;
  };
  return {
    put: (name: string, buffer: Buffer, mime: string) =>
      send(
        name,
        {
          method: "PUT",
          body: new Uint8Array(buffer),
          headers: { "Content-Type": mime },
          signal: AbortSignal.timeout(WRITE_TIMEOUT_MS),
        },
        (status) => status === 200,
      ),
    // Null when the object isn't there.
    get: async (name: string) => {
      const response = await send(name, { method: "GET" }, (status) => status === 200 || status === 404);
      return response.status === 404 ? null : response;
    },
    // Gone already counts as deleted.
    delete: (name: string) =>
      send(name, { method: "DELETE" }, (status) => status === 204 || status === 200 || status === 404),
  };
}

// The store that holds an R2 file's bytes. R2 being turned off doesn't bring its files back into the database.
async function storeFor(file: ImageFile) {
  const store = await objectStore();
  if (!store) throw new Error(`Image ${file.filename} is in R2, but R2 isn't set up (R2_* aren't set).`);
  return store;
}

async function write(filename: string, buffer: Buffer, metadata: ImageMetadata) {
  const store = await objectStore();
  if (!store) return writeToGridFS(filename, buffer, metadata);
  await store.put(filename, buffer, metadata.mime);
  const file = { filename, length: buffer.length, uploadDate: new Date(), metadata, storage: "r2" as const };
  try {
    await files().insertOne({ _id: new mongoose.Types.ObjectId(), ...file });
  } catch (error) {
    await store.delete(filename).catch(() => {}); // nothing would ever find it
    throw error;
  }
}

function writeToGridFS(filename: string, buffer: Buffer, metadata: ImageMetadata) {
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
  if (file.storage === "r2") {
    const response = await (await storeFor(file)).get(file.filename);
    // An entry whose object is gone reads as an image that has lost its data (see routes/image.routes.ts).
    // The cast: fetch's body is typed as the browser's stream, which is the same as Node's.
    const stream = response?.body ? Readable.fromWeb(response.body as NodeReadableStream) : Readable.from([]);
    return { stream, mime: file.metadata?.mime, size: file.length };
  }
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

// The stored files (small copies too) of those of `ids` that belong to `board`.
const filesAmong = (board: ObjectIdLike, ids: readonly string[]) =>
  files()
    .find({ "metadata.board": String(board), filename: { $in: [...ids, ...ids.map(smallName)] } })
    .toArray();

/** Bytes the images among `ids` that belong to `board` take, with their small copies. */
export async function imageBytesAmong(board: ObjectIdLike, ids: readonly string[]) {
  return (await filesAmong(board, ids)).reduce((sum, file) => sum + file.length, 0);
}

async function readFile(file: ImageFile) {
  if (file.storage !== "r2") return Buffer.concat(await getBucket().openDownloadStream(file._id).toArray());
  const response = await (await storeFor(file)).get(file.filename);
  if (!response) throw new Error(`Image ${file.filename} has lost its data.`);
  return Buffer.from(await response.arrayBuffer());
}

/** What copyImages is asked to copy, and where to. */
export interface CopyImages {
  from: ObjectIdLike;
  to: ObjectIdLike;
  ids: readonly string[];
  uploadedBy?: ObjectIdLike | null;
}

/**
 * Copies the images among `ids` that belong to board `from` (with their small copies) to board `to`, and resolves
 * with the copies' ids by the originals'. Images of other boards, and ones that are gone, aren't copied. If a copy
 * fails, those made so far are deleted.
 */
export async function copyImages({ from, to, ids, uploadedBy }: CopyImages) {
  const found = await filesAmong(from, ids);
  const copies = new Map<string, string>();
  try {
    for (const file of found.filter((file) => !file.metadata?.of)) {
      const small = found.find((other) => other.filename === smallName(file.filename));
      const id = await putImage({
        board: to,
        buffer: await readFile(file),
        mime: file.metadata?.mime ?? "",
        uploadedBy,
        small: small ? { buffer: await readFile(small), mime: small.metadata?.mime ?? "" } : null,
      });
      copies.set(file.filename, id);
    }
  } catch (error) {
    await deleteImages([...copies.values()]);
    throw error;
  }
  return copies;
}

/** Deletes images by id, with their small copies. */
export async function deleteImages(ids: string[]) {
  if (ids.length === 0) return;
  const found = await files()
    .find({ filename: { $in: [...ids, ...ids.map(smallName)] } }, { projection: { _id: 1, filename: 1, storage: 1 } })
    .toArray();
  for (const file of found) {
    try {
      if (file.storage === "r2") {
        await (await storeFor(file)).delete(file.filename);
        await files().deleteOne({ _id: file._id });
      } else {
        await getBucket().delete(file._id);
      }
    } catch (error) {
      // Keep going: the rest should still go, and a sweep finds what's left.
      // Whatever was thrown, a failed delete is an Error.
      console.error(`Couldn't delete a stored image: ${(error as Error).message}`);
    }
  }
}

/**
 * Moves the images kept in MongoDB (GridFS) to R2, one at a time, and resolves with how many it moved. Each is
 * written to R2 before its entry says so, and its chunks are deleted after, so it can be stopped and run again.
 * `onMoved` hears of each one. Run it once after setting R2_* (see scripts/move-images-to-r2.ts).
 */
export async function moveImagesToR2(onMoved: (count: number) => void = () => {}) {
  const store = await objectStore();
  if (!store)
    throw new Error("R2 isn't set up: set R2_ACCOUNT_ID, R2_ACCESS_KEY_ID, R2_SECRET_ACCESS_KEY and R2_BUCKET.");
  const chunks = mongoose.connection.db!.collection(`${BUCKET}.chunks`);
  let moved = 0;
  for (const id of await files().distinct("_id", { storage: { $ne: "r2" } })) {
    // Looked up again: it may have been deleted since the list was made.
    const file = await files().findOne({ _id: id, storage: { $ne: "r2" } });
    if (!file) continue;
    await store.put(file.filename, await readFile(file), file.metadata?.mime ?? "application/octet-stream");
    await files().updateOne({ _id: id }, { $set: { storage: "r2" } });
    await chunks.deleteMany({ files_id: id });
    onMoved(++moved);
  }
  return moved;
}

/** Deletes every image that belongs to a board. */
export async function deleteBoardImages(board: ObjectIdLike) {
  await deleteImages((await listImages({ boards: [board] })).map((image) => image.id));
}
