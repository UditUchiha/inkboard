import { imageUrl } from "./images";

// Small helpers for the files the board exports.

/** A board title made safe to use as a file name. */
export const safeFileName = (name) => name.replace(/[\\/:*?"<>|]+/g, "-").trim() || "board";

/** Saves `blob` to the person's computer as `fileName`. */
export function downloadBlob(blob, fileName) {
  const url = URL.createObjectURL(blob);
  const link = document.createElement("a");
  link.href = url;
  link.download = fileName;
  link.click();
  setTimeout(() => URL.revokeObjectURL(url), 1000);
}

export const dataUrlOf = (blob) =>
  new Promise((resolve, reject) => {
    const reader = new FileReader();
    reader.onload = () => resolve(reader.result);
    reader.onerror = () => reject(reader.error);
    reader.readAsDataURL(blob);
  });

/**
 * The full pictures used by `elements` as data URLs, by image id, so they can
 * travel inside an exported file. Pictures that can't be downloaded are left out.
 */
export async function pictureDataUrls(elements) {
  const ids = new Set(elements.filter((element) => element.type === "image").map((element) => element.imageId));
  const entries = await Promise.all(
    [...ids].map(async (id) => {
      try {
        const response = await fetch(imageUrl(id));
        return response.ok ? [id, await dataUrlOf(await response.blob())] : null;
      } catch {
        return null;
      }
    }),
  );
  return new Map(entries.filter(Boolean));
}
