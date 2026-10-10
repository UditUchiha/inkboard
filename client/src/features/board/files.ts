import type { Element as BoardElement } from "@inkboard/shared/types";
import { imageUrl } from "./images";

// Small helpers for the files the board exports.

/** A board title made safe to use as a file name. */
export const safeFileName = (name: string): string => name.replace(/[\\/:*?"<>|]+/g, "-").trim() || "board";

/** Saves `blob` to the person's computer as `fileName`. */
export function downloadBlob(blob: Blob, fileName: string) {
  const url = URL.createObjectURL(blob);
  const link = document.createElement("a");
  link.href = url;
  link.download = fileName;
  link.click();
  setTimeout(() => URL.revokeObjectURL(url), 1000);
}

export const dataUrlOf = (blob: Blob): Promise<string> =>
  new Promise((resolve, reject) => {
    const reader = new FileReader();
    reader.onload = () => resolve(reader.result as string); // the cast: it reads as a data URL, which is a string
    reader.onerror = () => reject(reader.error);
    reader.readAsDataURL(blob);
  });

/**
 * The full pictures used by `elements` as data URLs, by image id, so they can
 * travel inside an exported file. Pictures that can't be downloaded are left out.
 */
export async function pictureDataUrls(elements: BoardElement[]): Promise<Map<string, string>> {
  const ids = new Set(elements.filter((element) => element.type === "image").map((element) => element.imageId));
  const entries = await Promise.all(
    [...ids].map(async (id): Promise<[string, string] | null> => {
      try {
        const response = await fetch(imageUrl(id));
        return response.ok ? [id, await dataUrlOf(await response.blob())] : null;
      } catch {
        return null;
      }
    }),
  );
  // The cast: filter(Boolean) leaves only the entries there are, which TypeScript doesn't see.
  return new Map(entries.filter(Boolean) as [string, string][]);
}
