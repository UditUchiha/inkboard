import type { Element as BoardElement } from "@inkboard/shared/types";
import { imageUrl } from "./images";

export const safeFileName = (name: string): string => name.replace(/[\\/:*?"<>|]+/g, "-").trim() || "board";

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
  return new Map(entries.filter(Boolean) as [string, string][]);
}
