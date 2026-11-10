import { IMAGE_MAX_BYTES } from "@inkboard/shared/limits";
import type { ImageReply } from "@inkboard/shared/socket";
import type { Element as BoardElement } from "@inkboard/shared/types";
import { API_URL } from "../../../../config";
import type { AppSocket } from "../../../../providers/SocketProvider";
import type { Size } from "../elements/geometry";

// Pictures that aren't drawing: preparing them, uploading them and loading the ones others added.

export type ImageOptions = { small?: boolean };

export const imageUrl = (imageId: string, { small = false }: ImageOptions = {}): string =>
  `${API_URL}/api/images/${imageId}${small ? "/small" : ""}`;

// Types the server stores, plus ones the browser can open that are re-encoded; a file's type may be missing.
const ACCEPTED_TYPES = new Set<string | undefined>(["image/png", "image/jpeg", "image/webp", "image/gif"]);
const CONVERTED_TYPES = new Set<string | undefined>(["image/avif", "image/bmp", "image/heic", "image/heif"]);
export const MAX_SOURCE_BYTES = 25_000_000; // the file someone picks, before it is shrunk
export const MAX_SIDE = 2000; // pixels on the long side
const SEND_AS_IS_BYTES = 400_000; // small files are uploaded untouched
const UPLOAD_LIMIT_BYTES = IMAGE_MAX_BYTES * 0.9; // under the server's limit, with room to spare
// Thumbnails draw from a small copy so a page of boards doesn't download every full-size picture.
const SMALL_SIDE = 400;
const SMALL_QUALITY = 0.75;
// Tried in order until the result fits: longest side in pixels, then quality.
const ATTEMPTS = [
  [MAX_SIDE, 0.85],
  [1600, 0.8],
  [1200, 0.75],
  [800, 0.7],
];

export type PreparedImage = { blob: Blob; width: number; height: number; small: Blob | null };

type UploadReply = Extract<ImageReply, { ok: true }> | Partial<Extract<ImageReply, { ok: false }>>;

export class ImageError extends Error {}

export const isImageFile = (file: { type?: string } | null | undefined): boolean =>
  ACCEPTED_TYPES.has(file?.type) || CONVERTED_TYPES.has(file?.type);

export function fitWithin(width: number, height: number, maxSide: number): Size {
  const scale = Math.min(1, maxSide / Math.max(width, height));
  return { width: Math.max(1, Math.round(width * scale)), height: Math.max(1, Math.round(height * scale)) };
}

// No bigger than `fill` of the visible area `view`, so a large photo doesn't land bigger than the window.
export function placementSize({ width, height }: Size, view: Size, fill = 0.6): Size {
  const scale = Math.min(1, (view.width * fill) / width, (view.height * fill) / height);
  return { width: Math.max(1, width * scale), height: Math.max(1, height * scale) };
}

const toBlob = (canvas: HTMLCanvasElement, type: string, quality?: number): Promise<Blob | null> =>
  new Promise((resolve) => canvas.toBlob(resolve, type, quality));

function hasTransparency(context: CanvasRenderingContext2D, { width, height }: Size): boolean {
  const { data } = context.getImageData(0, 0, width, height);
  for (let index = 3; index < data.length; index += 4) if (data[index] < 255) return true;
  return false;
}

// Safari can't write WebP and hands back a huge PNG: a picture with nothing see-through is written as JPEG instead.
async function encode(bitmap: ImageBitmap, size: Size, quality: number): Promise<Blob | null> {
  const canvas = document.createElement("canvas");
  canvas.width = size.width;
  canvas.height = size.height;
  const context = canvas.getContext("2d")!;
  context.drawImage(bitmap, 0, 0, size.width, size.height);
  const blob = await toBlob(canvas, "image/webp", quality);
  if (!blob || blob.type === "image/webp" || hasTransparency(context, size)) return blob;
  return (await toBlob(canvas, "image/jpeg", quality)) ?? blob;
}

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

export async function uploadImage(
  socket: AppSocket | null | undefined,
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

export type ImageState = "loading" | "ready" | "failed";

export type ImageEntry = { image: HTMLImageElement; state: ImageState; failedAt: number; failures: number };

const RETRY_AFTER_MS = 10_000; // after a first failure; doubled after each further one, up to MAX_RETRY_AFTER_MS
const MAX_RETRY_AFTER_MS = 300_000;
export const MAX_CACHED = 300; // pictures kept, oldest used dropped first, unless more than that are on show
const entries = new Map<string, ImageEntry>(); // imageId -> { image, state: "loading" | "ready" | "failed", failedAt, failures }, least recently used first
const shown = new Map<HTMLCanvasElement, Set<string>>(); // canvas -> the keys of the pictures it last drew (see showingImages)
const listeners = new Set<() => void>();
let version = 0;
let evictionDue = false;

export function picturesChanged() {
  version += 1;
  for (const listener of listeners) listener();
}

export const subscribeImages = (listener: () => void) => {
  listeners.add(listener);
  return () => listeners.delete(listener);
};
export const imagesVersion = (): number => version;

const keyFor = (imageId: string, small: boolean): string => (small ? `${imageId}/small` : imageId);

// Pictures on show are kept however many: dropping one would make the next redraw fetch it, and then another, flashing
// every picture back to its placeholder.
export function showingImages(
  canvas: HTMLCanvasElement,
  imageIds: ReadonlySet<string>,
  { small = false }: ImageOptions = {},
): void {
  // Sweep here, not only in evict() (a no-op while the cache is small): a canvas that left the page mustn't stay
  // referenced with its pixels.
  for (const other of shown.keys()) if (other !== canvas && other.isConnected === false) shown.delete(other);
  if (imageIds.size === 0) shown.delete(canvas);
  else shown.set(canvas, new Set([...imageIds].map((imageId) => keyFor(imageId, small))));
}

export const releaseImages = (canvas: HTMLCanvasElement): void => {
  shown.delete(canvas);
};

export const canvasesShowing = (): number => shown.size;

// Evicts the least recently used once there are too many, except those still loading or on show.
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
    picturesChanged();
  };
  image.onerror = () => {
    entry.state = "failed";
    entry.failedAt = Date.now();
    entry.failures += 1;
    picturesChanged();
  };
  image.src = src;
  return entry;
}

export const imageState = (imageId: string, { small = false }: ImageOptions = {}): ImageState | null =>
  entries.get(keyFor(imageId, small))?.state ?? null;

// `small` asks for the thumbnail; the server sends the full picture for images uploaded before small copies existed.
export function getImage(imageId: string, { small = false }: ImageOptions = {}): ImageEntry {
  const key = keyFor(imageId, small);
  const entry = entries.get(key);
  if (!entry) return track(key, imageUrl(imageId, { small }));
  // A failed download is retried with growing waits, so a picture that is gone for good isn't asked for every few
  // seconds.
  const wait = Math.min(RETRY_AFTER_MS * 2 ** (entry.failures - 1), MAX_RETRY_AFTER_MS);
  if (entry.state === "failed" && Date.now() - entry.failedAt > wait) {
    return track(key, imageUrl(imageId, { small }), { failures: entry.failures });
  }
  entries.delete(key); // now the most recently used
  entries.set(key, entry);
  return entry;
}

export function primeImage(imageId: string, blob: Blob, { small = false }: ImageOptions = {}): void {
  const key = keyFor(imageId, small);
  const src = URL.createObjectURL(blob);
  const { image } = track(key, src, { crossOrigin: false });
  // A loaded picture keeps its pixels, so the local copy can be let go.
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
