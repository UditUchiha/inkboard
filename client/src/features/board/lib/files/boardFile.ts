import { cleanElement } from "@inkboard/shared/element-rules";
import type { Element as BoardElement } from "@inkboard/shared/types";
import { MAX_ELEMENTS_PER_BOARD } from "../../constants/board";
import { copyGroup } from "../elements/connectors";
import { getSceneBounds } from "../elements/elements";
import type { XY } from "../elements/geometry";

// A .inkboard.json file: elements plus pictures as data URLs so it stands alone; importing adds them with new ids and re-uploads the pictures.

export const BOARD_FILE_TYPE = "inkboard";
export const BOARD_FILE_VERSION = 1;
export const BOARD_FILE_EXTENSION = ".inkboard.json";

// A board file is mostly its pictures; the pictures' own limit is 25 MB each.
export const MAX_BOARD_FILE_BYTES = 100_000_000;

export type BoardFile = {
  type: typeof BOARD_FILE_TYPE;
  version: number;
  title: string;
  exportedAt: string;
  elements: BoardElement[];
  images: Record<string, string>;
};

export type ParsedBoardFile = {
  title: string;
  elements: BoardElement[];
  pictures: Map<string, string>;
  skipped: number;
};

type RawBoardFile = {
  type?: unknown;
  version?: unknown;
  title?: unknown;
  elements?: unknown;
  images?: Record<string, unknown> | null;
} | null;

export class BoardFileError extends Error {}

export const isBoardFile = (file: { name?: string; type?: string } | null | undefined): boolean =>
  /\.json$/i.test(file?.name ?? "") || file?.type === "application/json";

export function makeBoardFile({
  title,
  elements,
  pictures = new Map(),
}: {
  title: string;
  elements: BoardElement[];
  pictures?: Map<string, string>;
}): BoardFile {
  const used = new Set(elements.filter((element) => element.type === "image").map((element) => element.imageId));
  return {
    type: BOARD_FILE_TYPE,
    version: BOARD_FILE_VERSION,
    title,
    exportedAt: new Date().toISOString(),
    elements,
    images: Object.fromEntries([...pictures].filter(([id]) => used.has(id))),
  };
}

export function parseBoardFile(text: string): ParsedBoardFile {
  let data: RawBoardFile;
  try {
    data = JSON.parse(text);
  } catch {
    throw new BoardFileError("That file isn't a board file. Choose a .inkboard.json file exported from Inkboard.");
  }
  if (data?.type !== BOARD_FILE_TYPE || !Array.isArray(data.elements)) {
    throw new BoardFileError("That file isn't a board file. Choose a .inkboard.json file exported from Inkboard.");
  }
  if (Number(data.version) > BOARD_FILE_VERSION) {
    throw new BoardFileError("That file was made by a newer version of Inkboard. Reload the page and try again.");
  }
  if (data.elements.length > MAX_ELEMENTS_PER_BOARD) {
    throw new BoardFileError(
      `That board file has more than ${MAX_ELEMENTS_PER_BOARD} elements, more than a board holds.`,
    );
  }
  // Elements go through the server's rules, so the board shows what the server will keep.
  const elements = data.elements.map(cleanElement).filter(Boolean) as BoardElement[];
  if (elements.length === 0) {
    throw new BoardFileError(
      data.elements.length === 0
        ? "That board file is empty."
        : "None of the elements in that board file could be read.",
    );
  }

  const pictures = new Map<string, string>();
  for (const [id, url] of Object.entries(data.images ?? {})) {
    if (typeof url === "string" && url.startsWith("data:image/")) pictures.set(id, url);
  }
  return {
    title: typeof data.title === "string" ? data.title : "",
    elements,
    pictures,
    skipped: data.elements.length - elements.length,
  };
}

export async function readBoardFile(file: File): Promise<ParsedBoardFile> {
  if (file.size > MAX_BOARD_FILE_BYTES) {
    throw new BoardFileError(`That file is too big to import (over ${MAX_BOARD_FILE_BYTES / 1_000_000} MB).`);
  }
  return parseBoardFile(await file.text());
}

// By hand: the page's content security policy doesn't allow fetch(url) for data URLs.
export function dataUrlToBlob(url: string): Blob {
  const match = /^data:([^,;]*)([^,]*),/.exec(url);
  if (!match) throw new BoardFileError("A picture in that file is damaged.");
  const body = url.slice(match[0].length);
  let bytes: Uint8Array<ArrayBuffer>;
  if (match[2].endsWith(";base64")) {
    const binary = atob(body);
    bytes = new Uint8Array(binary.length);
    for (let index = 0; index < binary.length; index += 1) bytes[index] = binary.charCodeAt(index);
  } else {
    bytes = new TextEncoder().encode(decodeURIComponent(body));
  }
  return new Blob([bytes], { type: match[1] || "application/octet-stream" });
}

export function placeElements(elements: BoardElement[], center: XY): BoardElement[] {
  const bounds = getSceneBounds(elements);
  const dx = bounds ? center.x - (bounds.x + bounds.width / 2) : 0;
  const dy = bounds ? center.y - (bounds.y + bounds.height / 2) : 0;
  return copyGroup(elements, elements, dx, dy, { sameLook: true });
}
