import { randomBytes } from "node:crypto";
import { Readable } from "node:stream";
import mongoose from "mongoose";

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

let bucket;
let bucketDb;

function getBucket() {
  const db = mongoose.connection.db;
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

const files = () => mongoose.connection.db.collection(`${BUCKET}.files`);

export const IMAGE_ID = /^[a-f0-9]{32}$/;

const smallName = (id) => `${id}.small`;

// Narrows a query to some boards' images (all images when `boards` is left out),
// and to those uploaded before a moment. Small copies count towards space used
// but aren't listed: they belong to their image.
function matching({ boards, uploadedBefore } = {}, { withSmall = false } = {}) {
  const query = withSmall ? {} : { "metadata.of": { $exists: false } };
  if (boards) query["metadata.board"] = { $in: boards.map(String) };
  if (uploadedBefore) query.uploadDate = { $lt: uploadedBefore };
  return query;
}

function write(filename, buffer, metadata) {
  return new Promise((resolve, reject) => {
    const upload = getBucket().openUploadStream(filename, { metadata });
    upload.once("error", reject);
    upload.once("finish", resolve);
    Readable.from([buffer]).pipe(upload);
  });
}

/** Stores an image, and its small copy `{ buffer, mime }` if given, and returns its id. */
export async function putImage({ board, buffer, mime, uploadedBy, small }) {
  const id = randomBytes(16).toString("hex");
  const metadata = { board: String(board), mime, uploadedBy: uploadedBy ?? null };
  await write(id, buffer, metadata);
  if (small) await write(smallName(id), small.buffer, { ...metadata, mime: small.mime, of: id });
  return id;
}

/**
 * `{ stream, mime, size }` for an image, or null if there is no such image.
 * `small` asks for its small copy, and gets the image itself when it has none.
 */
export async function openImage(id, { small = false } = {}) {
  if (!IMAGE_ID.test(id)) return null;
  const file =
    (small && (await files().findOne({ filename: smallName(id) }))) || (await files().findOne({ filename: id }));
  if (!file) return null;
  return { stream: getBucket().openDownloadStream(file._id), mime: file.metadata?.mime, size: file.length };
}

/** Bytes of images held by some boards, or by every board when `boards` is left out. */
export async function imageBytes({ boards } = {}) {
  const [total] = await files()
    .aggregate([
      { $match: matching({ boards }, { withSmall: true }) },
      { $group: { _id: null, bytes: { $sum: "$length" } } },
    ])
    .toArray();
  return total?.bytes ?? 0;
}

/** `[{ id, board }]` for images matching `{ boards, uploadedBefore }` (both optional). */
export async function listImages(filter) {
  const found = await files()
    .find(matching(filter), { projection: { filename: 1, "metadata.board": 1 } })
    .toArray();
  return found.map((file) => ({ id: file.filename, board: file.metadata?.board }));
}

/** Deletes images by id, with their small copies. */
export async function deleteImages(ids) {
  if (ids.length === 0) return;
  const found = await files()
    .find({ filename: { $in: [...ids, ...ids.map(smallName)] } }, { projection: { _id: 1 } })
    .toArray();
  for (const file of found)
    await getBucket()
      .delete(file._id)
      .catch(() => {});
}

/** Deletes every image that belongs to a board. */
export async function deleteBoardImages(board) {
  await deleteImages((await listImages({ boards: [board] })).map((image) => image.id));
}
