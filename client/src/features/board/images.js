import { API_URL } from "../../config";

// Everything about pictures on the board that isn't drawing: getting them ready
// to upload, uploading them, and loading the ones other people added.

/** Where an image is downloaded from; `small` is the copy made for thumbnails. */
export const imageUrl = (imageId, { small = false } = {}) => `${API_URL}/api/images/${imageId}${small ? "/small" : ""}`;

// ---------------------------------------------------------------------------
// Getting a picture ready
// ---------------------------------------------------------------------------

const ACCEPTED_TYPES = new Set(["image/png", "image/jpeg", "image/webp", "image/gif"]);
export const MAX_SOURCE_BYTES = 25_000_000; // the file someone picks, before it is shrunk
export const MAX_SIDE = 2000; // pixels on the long side
const SEND_AS_IS_BYTES = 400_000; // small files are uploaded untouched
const UPLOAD_LIMIT_BYTES = 1_800_000; // the server's limit is 2 MB
// Thumbnails (dashboard cards, version history) draw from a small copy, so a
// page of boards doesn't download every full-size picture on them.
const SMALL_SIDE = 400;
const SMALL_QUALITY = 0.75;
// Tried in order until the result fits: longest side in pixels, then quality.
const ATTEMPTS = [
  [MAX_SIDE, 0.85],
  [1600, 0.8],
  [1200, 0.75],
  [800, 0.7],
];

/** A problem with a picture that can be shown to the person as it is. */
export class ImageError extends Error {}

export const isImageFile = (file) => ACCEPTED_TYPES.has(file?.type);

/** `{ width, height }` scaled down, never up, so its longer side is at most `maxSide`. */
export function fitWithin(width, height, maxSide) {
  const scale = Math.min(1, maxSide / Math.max(width, height));
  return { width: Math.max(1, Math.round(width * scale)), height: Math.max(1, Math.round(height * scale)) };
}

/**
 * How big a new picture is on the board: its own size, but no more than `fill`
 * of what is on screen, so a large photo doesn't land bigger than the window.
 * `view` is the visible area in board units.
 */
export function placementSize({ width, height }, view, fill = 0.6) {
  const scale = Math.min(1, (view.width * fill) / width, (view.height * fill) / height);
  return { width: Math.max(1, width * scale), height: Math.max(1, height * scale) };
}

const toBlob = (canvas, type, quality) => new Promise((resolve) => canvas.toBlob(resolve, type, quality));

// The picture redrawn at `size`, as WebP. A browser that can't write WebP hands
// back a PNG, which the server also accepts. Resolves with null if it fails.
function encode(bitmap, size, quality) {
  const canvas = document.createElement("canvas");
  canvas.width = size.width;
  canvas.height = size.height;
  canvas.getContext("2d").drawImage(bitmap, 0, 0, size.width, size.height);
  return toBlob(canvas, "image/webp", quality);
}

// The copy to store: the file itself when it's already small, otherwise the
// largest shrunk version that fits under the upload limit.
async function fullSize(file, bitmap) {
  if (file.size <= SEND_AS_IS_BYTES && Math.max(bitmap.width, bitmap.height) <= MAX_SIDE) {
    return { blob: file, width: bitmap.width, height: bitmap.height };
  }
  for (const [side, quality] of ATTEMPTS) {
    const size = fitWithin(bitmap.width, bitmap.height, side);
    // WebP keeps see-through areas and is much smaller than PNG.
    const blob = await encode(bitmap, size, quality);
    if (blob && blob.size <= UPLOAD_LIMIT_BYTES) return { blob, ...size };
  }
  throw new ImageError("That image is too detailed to upload. Try a smaller one.");
}

/**
 * Shrinks a picked file so it uploads quickly and doesn't eat the board's image
 * space. Returns `{ blob, small, width, height }`: the picture as it will be
 * stored and its size, and a small copy for thumbnails (null if it couldn't be
 * made). Throws an ImageError describing what's wrong.
 */
export async function prepareImage(file) {
  if (!isImageFile(file)) throw new ImageError("Use a PNG, JPEG, WebP or GIF image.");
  if (file.size > MAX_SOURCE_BYTES) throw new ImageError("That file is too big. Use one under 25 MB.");

  let bitmap;
  try {
    bitmap = await createImageBitmap(file);
  } catch {
    throw new ImageError("That image couldn't be opened. It may be damaged.");
  }

  try {
    const stored = await fullSize(file, bitmap);
    const small = await encode(bitmap, fitWithin(bitmap.width, bitmap.height, SMALL_SIDE), SMALL_QUALITY);
    return { ...stored, small };
  } finally {
    bitmap.close?.();
  }
}

/** Sends a prepared picture (and its small copy, if any) to the server and resolves with its new image id. */
export async function uploadImage(socket, boardId, { blob, small }) {
  if (!socket?.connected) throw new ImageError("You're offline. Reconnect to add images.");
  const data = await blob.arrayBuffer();
  const smallData = small ? await small.arrayBuffer() : undefined;
  const reply = await new Promise((resolve) => {
    socket.timeout(30_000).emit("board:image", { boardId, data, small: smallData }, (error, response) => {
      resolve(error ? { error: "The upload took too long. Try again." } : response);
    });
  });
  if (reply?.ok) return reply.id;
  if (reply?.readOnly) throw new ImageError("You can only view this board, so you can't add images.");
  throw new ImageError(reply?.error ?? "The image couldn't be uploaded. Try again.");
}

// ---------------------------------------------------------------------------
// Pictures on the board
// ---------------------------------------------------------------------------

const RETRY_AFTER_MS = 10_000;
const entries = new Map(); // imageId -> { image, state: "loading" | "ready" | "failed", failedAt }
const listeners = new Set();
let version = 0;

function changed() {
  version += 1;
  for (const listener of listeners) listener();
}

// For React's useSyncExternalStore: canvases redraw when a picture finishes loading.
export const subscribeImages = (listener) => {
  listeners.add(listener);
  return () => listeners.delete(listener);
};
export const imagesVersion = () => version;

function track(key, src, { crossOrigin = true } = {}) {
  const image = new Image();
  // Without this, drawing the picture would make the canvas unexportable as PNG.
  if (crossOrigin) image.crossOrigin = "anonymous";
  const entry = { image, state: "loading", failedAt: 0 };
  entries.set(key, entry);
  image.onload = () => {
    entry.state = "ready";
    changed();
  };
  image.onerror = () => {
    entry.state = "failed";
    entry.failedAt = Date.now();
    changed();
  };
  image.src = src;
  return entry;
}

const keyFor = (imageId, small) => (small ? `${imageId}/small` : imageId);

/**
 * The picture for an image id, starting to download it the first time it's
 * asked for. `small` asks for the thumbnail copy (the server sends the full
 * picture for images uploaded before small copies existed).
 */
export function getImage(imageId, { small = false } = {}) {
  const key = keyFor(imageId, small);
  const entry = entries.get(key);
  if (!entry) return track(key, imageUrl(imageId, { small }));
  // A failed download (a dropped connection, say) is tried again now and then.
  if (entry.state === "failed" && Date.now() - entry.failedAt > RETRY_AFTER_MS) {
    return track(key, imageUrl(imageId, { small }));
  }
  return entry;
}

/** Shows a just-uploaded picture straight away instead of downloading it back. */
export function primeImage(imageId, blob, { small = false } = {}) {
  const key = keyFor(imageId, small);
  const src = URL.createObjectURL(blob);
  const { image } = track(key, src, { crossOrigin: false });
  // A loaded picture keeps its pixels, so the local copy can be let go of then.
  const markReady = image.onload;
  image.onload = () => {
    URL.revokeObjectURL(src);
    markReady();
  };
  // If the local copy can't be shown for any reason, download it like anyone else would.
  image.onerror = () => {
    URL.revokeObjectURL(src);
    track(key, imageUrl(imageId, { small }));
  };
}

/** Resolves once every picture used by `elements` has loaded or failed. */
export function loadImagesOf(elements) {
  const ids = new Set(elements.filter((element) => element.type === "image").map((element) => element.imageId));
  return Promise.all(
    [...ids].map((imageId) => {
      const { image, state } = getImage(imageId);
      if (state !== "loading") return null;
      return new Promise((resolve) => {
        image.addEventListener("load", resolve, { once: true });
        image.addEventListener("error", resolve, { once: true });
      });
    }),
  );
}
