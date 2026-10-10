import { IMAGE_MAX_BYTES } from "@inkboard/shared/limits";
import type { Element as BoardElement } from "@inkboard/shared/types";
import type { Socket } from "socket.io-client";
import { API_URL } from "../../config";
import type { Size } from "./geometry";

// Everything about pictures on the board that isn't drawing: getting them ready
// to upload, uploading them, and loading the ones other people added.

/** Which copy of a picture: the full one, or `small`, the copy made for thumbnails. */
export type ImageOptions = { small?: boolean };

/** Where an image is downloaded from; `small` is the copy made for thumbnails. */
export const imageUrl = (imageId: string, { small = false }: ImageOptions = {}): string =>
  `${API_URL}/api/images/${imageId}${small ? "/small" : ""}`;

// ---------------------------------------------------------------------------
// Getting a picture ready
// ---------------------------------------------------------------------------

// What the server stores, and what else the browser may be able to open, which is re-encoded as one of those.
// (They're asked about a file whose type may be missing, so they take undefined too.)
const ACCEPTED_TYPES = new Set<string | undefined>(["image/png", "image/jpeg", "image/webp", "image/gif"]);
const CONVERTED_TYPES = new Set<string | undefined>(["image/avif", "image/bmp", "image/heic", "image/heif"]);
export const MAX_SOURCE_BYTES = 25_000_000; // the file someone picks, before it is shrunk
export const MAX_SIDE = 2000; // pixels on the long side
const SEND_AS_IS_BYTES = 400_000; // small files are uploaded untouched
const UPLOAD_LIMIT_BYTES = IMAGE_MAX_BYTES * 0.9; // under the server's limit, with room to spare
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

/** A picture ready to upload: as it will be stored, its size, and a small copy for thumbnails (null if it couldn't be made). */
export type PreparedImage = { blob: Blob; width: number; height: number; small: Blob | null };

// What the server answers to an uploaded picture: its image id, or what went wrong.
type UploadReply = { ok: true; id: string } | { ok?: false; readOnly?: boolean; error?: string };

/** A problem with a picture that can be shown to the person as it is. */
export class ImageError extends Error {}

export const isImageFile = (file: { type?: string } | null | undefined): boolean =>
  ACCEPTED_TYPES.has(file?.type) || CONVERTED_TYPES.has(file?.type);

/** `{ width, height }` scaled down, never up, so its longer side is at most `maxSide`. */
export function fitWithin(width: number, height: number, maxSide: number): Size {
  const scale = Math.min(1, maxSide / Math.max(width, height));
  return { width: Math.max(1, Math.round(width * scale)), height: Math.max(1, Math.round(height * scale)) };
}

/**
 * How big a new picture is on the board: its own size, but no more than `fill`
 * of what is on screen, so a large photo doesn't land bigger than the window.
 * `view` is the visible area in board units.
 */
export function placementSize({ width, height }: Size, view: Size, fill = 0.6): Size {
  const scale = Math.min(1, (view.width * fill) / width, (view.height * fill) / height);
  return { width: Math.max(1, width * scale), height: Math.max(1, height * scale) };
}

const toBlob = (canvas: HTMLCanvasElement, type: string, quality?: number): Promise<Blob | null> =>
  new Promise((resolve) => canvas.toBlob(resolve, type, quality));

// Whether any pixel of the canvas is see-through.
function hasTransparency(context: CanvasRenderingContext2D, { width, height }: Size): boolean {
  const { data } = context.getImageData(0, 0, width, height);
  for (let index = 3; index < data.length; index += 4) if (data[index] < 255) return true;
  return false;
}

// The picture redrawn at `size`, as WebP. A browser that can't write WebP (Safari) hands back a
// PNG, which is huge for a photo: a picture with nothing see-through is written as JPEG instead.
// Resolves with null if it fails.
async function encode(bitmap: ImageBitmap, size: Size, quality: number): Promise<Blob | null> {
  const canvas = document.createElement("canvas");
  canvas.width = size.width;
  canvas.height = size.height;
  // The assertion: a new canvas always gives a 2d context.
  const context = canvas.getContext("2d")!;
  context.drawImage(bitmap, 0, 0, size.width, size.height);
  const blob = await toBlob(canvas, "image/webp", quality);
  if (!blob || blob.type === "image/webp" || hasTransparency(context, size)) return blob;
  return (await toBlob(canvas, "image/jpeg", quality)) ?? blob;
}

// The copy to store: the file itself when it's already small, otherwise the
// largest shrunk version that fits under the upload limit.
async function fullSize(file: File, bitmap: ImageBitmap): Promise<Size & { blob: Blob }> {
  const asIs = ACCEPTED_TYPES.has(file.type) && file.size <= SEND_AS_IS_BYTES;
  if (asIs && Math.max(bitmap.width, bitmap.height) <= MAX_SIDE) {
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
export async function prepareImage(file: File): Promise<PreparedImage> {
  if (!isImageFile(file)) throw new ImageError("Use a PNG, JPEG, WebP or GIF image.");
  if (file.size > MAX_SOURCE_BYTES) throw new ImageError("That file is too big. Use one under 25 MB.");

  let bitmap: ImageBitmap;
  try {
    bitmap = await createImageBitmap(file);
  } catch {
    throw new ImageError(
      CONVERTED_TYPES.has(file.type)
        ? "This browser can't open that kind of image. Use a PNG, JPEG, WebP or GIF."
        : "That image couldn't be opened. It may be damaged.",
    );
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
export async function uploadImage(
  socket: Socket | null | undefined,
  boardId: string,
  { blob, small }: { blob: Blob; small?: Blob | null },
): Promise<string> {
  if (!socket?.connected) throw new ImageError("You're offline. Reconnect to add images.");
  const data = await blob.arrayBuffer();
  const smallData = small ? await small.arrayBuffer() : undefined;
  const reply = await new Promise<UploadReply | undefined>((resolve) => {
    socket
      .timeout(30_000)
      .emit(
        "board:image",
        { boardId, data, small: smallData },
        (error: Error | null, response: UploadReply | undefined) => {
          resolve(error ? { error: "The upload took too long. Try again." } : response);
        },
      );
  });
  if (reply?.ok) return reply.id;
  if (reply?.readOnly) throw new ImageError("You can only view this board, so you can't add images.");
  throw new ImageError(reply?.error ?? "The image couldn't be uploaded. Try again.");
}

// ---------------------------------------------------------------------------
// Pictures on the board
// ---------------------------------------------------------------------------

/** How far a picture has got: still downloading, shown, or not to be had. */
export type ImageState = "loading" | "ready" | "failed";

/** A picture kept by the cache: the image, how far it has got, and when and how often it failed. */
export type ImageEntry = { image: HTMLImageElement; state: ImageState; failedAt: number; failures: number };

const RETRY_AFTER_MS = 10_000; // after a first failure; doubled after each further one, up to MAX_RETRY_AFTER_MS
const MAX_RETRY_AFTER_MS = 300_000;
export const MAX_CACHED = 300; // pictures kept, oldest used dropped first, unless more than that are on show
const entries = new Map<string, ImageEntry>(); // imageId -> { image, state: "loading" | "ready" | "failed", failedAt, failures }, least recently used first
const shown = new Map<HTMLCanvasElement, Set<string>>(); // canvas -> the keys of the pictures it last drew (see showingImages)
const listeners = new Set<() => void>();
let version = 0;
let evictionDue = false;

function changed() {
  version += 1;
  for (const listener of listeners) listener();
}

// For React's useSyncExternalStore: canvases redraw when a picture finishes loading.
export const subscribeImages = (listener: () => void) => {
  listeners.add(listener);
  return () => listeners.delete(listener);
};
export const imagesVersion = (): number => version;

const keyFor = (imageId: string, small: boolean): string => (small ? `${imageId}/small` : imageId);

/**
 * Records which pictures (image ids, small copies if `small`) `canvas` drew last. They're on show, so
 * they're kept however many there are: dropping one would only have the next redraw fetch it again, and,
 * with more on show than the cache holds, drop another, so that every picture kept flashing back to its
 * placeholder. A canvas no longer on the page lets go of its pictures.
 */
export function showingImages(
  canvas: HTMLCanvasElement,
  imageIds: ReadonlySet<string>,
  { small = false }: ImageOptions = {},
): void {
  // Sweep here, not only in evict(), which does nothing while the cache is small: a canvas that left the
  // page (a dashboard card, an export's offscreen canvas) must not stay referenced, with its pixels, for good.
  for (const other of shown.keys()) if (other !== canvas && other.isConnected === false) shown.delete(other);
  if (imageIds.size === 0) shown.delete(canvas);
  else shown.set(canvas, new Set([...imageIds].map((imageId) => keyFor(imageId, small))));
}

/** Lets go of a canvas that is done with (unmounted, or an export's offscreen one) and of the pictures it held on show. */
export const releaseImages = (canvas: HTMLCanvasElement): void => {
  shown.delete(canvas);
};

/** How many canvases are held as showing pictures (for tests: none should linger once it is off the page). */
export const canvasesShowing = (): number => shown.size;

// Drops the pictures used longest ago once there are too many, so a long session doesn't keep every one it
// ever showed. Not those still loading, nor those a canvas on the page last drew (see showingImages).
function evict() {
  evictionDue = false;
  if (entries.size <= MAX_CACHED) return;
  for (const canvas of shown.keys()) if (canvas.isConnected === false) shown.delete(canvas);
  const onShow = new Set([...shown.values()].flatMap((keys) => [...keys]));
  for (const [key, entry] of entries) {
    if (entries.size <= MAX_CACHED) return;
    if (entry.state !== "loading" && !onShow.has(key)) entries.delete(key);
  }
}

// Dropping waits until whatever is being drawn now has been, and has said which pictures it showed.
function evictSoon() {
  if (evictionDue) return;
  evictionDue = true;
  setTimeout(evict, 0);
}

function track(
  key: string,
  src: string,
  { crossOrigin = true, failures = 0 }: { crossOrigin?: boolean; failures?: number } = {},
): ImageEntry {
  const image = new Image();
  // Without this, drawing the picture would make the canvas unexportable as PNG.
  if (crossOrigin) image.crossOrigin = "anonymous";
  const entry: ImageEntry = { image, state: "loading", failedAt: 0, failures };
  entries.delete(key);
  entries.set(key, entry);
  evictSoon();
  image.onload = () => {
    entry.state = "ready";
    entry.failures = 0;
    changed();
  };
  image.onerror = () => {
    entry.state = "failed";
    entry.failedAt = Date.now();
    entry.failures += 1;
    changed();
  };
  image.src = src;
  return entry;
}

/** How far the picture for an image id has got ("loading", "ready" or "failed"), or null if it isn't kept; asks for nothing. */
export const imageState = (imageId: string, { small = false }: ImageOptions = {}): ImageState | null =>
  entries.get(keyFor(imageId, small))?.state ?? null;

/**
 * The picture for an image id, starting to download it the first time it's
 * asked for. `small` asks for the thumbnail copy (the server sends the full
 * picture for images uploaded before small copies existed).
 */
export function getImage(imageId: string, { small = false }: ImageOptions = {}): ImageEntry {
  const key = keyFor(imageId, small);
  const entry = entries.get(key);
  if (!entry) return track(key, imageUrl(imageId, { small }));
  // A failed download (a dropped connection, say) is tried again now and then, less often each time:
  // a picture that is gone for good isn't asked for every few seconds for as long as the board is open.
  const wait = Math.min(RETRY_AFTER_MS * 2 ** (entry.failures - 1), MAX_RETRY_AFTER_MS);
  if (entry.state === "failed" && Date.now() - entry.failedAt > wait) {
    return track(key, imageUrl(imageId, { small }), { failures: entry.failures });
  }
  entries.delete(key); // now the most recently used
  entries.set(key, entry);
  return entry;
}

/** Shows a just-uploaded picture straight away instead of downloading it back. */
export function primeImage(imageId: string, blob: Blob, { small = false }: ImageOptions = {}): void {
  const key = keyFor(imageId, small);
  const src = URL.createObjectURL(blob);
  const { image } = track(key, src, { crossOrigin: false });
  // A loaded picture keeps its pixels, so the local copy can be let go of then.
  // The cast: track set `onload` to a plain function.
  const markReady = image.onload as () => void;
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
export function loadImagesOf(elements: BoardElement[]) {
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
