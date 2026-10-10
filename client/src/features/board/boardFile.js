import { cleanElement } from "@inkboard/shared/element-rules";
import { MAX_ELEMENTS_PER_BOARD } from "./constants";
import { copyGroup } from "./connectors";
import { getSceneBounds } from "./elements";

// A board saved as a file (.inkboard.json): its elements, plus the pictures on
// it as data URLs so the file stands on its own. Importing adds the elements to
// the open board with new ids, and uploads the pictures again so they belong
// to that board.

export const BOARD_FILE_TYPE = "inkboard";
export const BOARD_FILE_VERSION = 1;
export const BOARD_FILE_EXTENSION = ".inkboard.json";

// A board file is mostly its pictures; the pictures' own limit is 25 MB each.
export const MAX_BOARD_FILE_BYTES = 100_000_000;

/** A problem with a board file that can be shown to the person as it is. */
export class BoardFileError extends Error {}

export const isBoardFile = (file) => /\.json$/i.test(file?.name ?? "") || file?.type === "application/json";

/** The file's contents for a board's `elements`, with `pictures` mapping image ids to data URLs. */
export function makeBoardFile({ title, elements, pictures = new Map() }) {
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

/** Reads a board file's text. Returns `{ title, elements, pictures, skipped }` or throws a BoardFileError. */
export function parseBoardFile(text) {
  let data;
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
  // Every element goes through the rules the server applies to what it stores, so the
  // board shows what the server will keep, and nothing in the file can break drawing.
  const elements = data.elements.map(cleanElement).filter(Boolean);
  if (elements.length === 0) {
    throw new BoardFileError(
      data.elements.length === 0
        ? "That board file is empty."
        : "None of the elements in that board file could be read.",
    );
  }

  const pictures = new Map();
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

/** Reads a file someone picked as a board file (see parseBoardFile). */
export async function readBoardFile(file) {
  if (file.size > MAX_BOARD_FILE_BYTES) {
    throw new BoardFileError(`That file is too big to import (over ${MAX_BOARD_FILE_BYTES / 1_000_000} MB).`);
  }
  return parseBoardFile(await file.text());
}

/**
 * The bytes of a data URL as a Blob. This is done by hand rather than with
 * `fetch(url)`, which the page's content security policy doesn't allow for data URLs.
 */
export function dataUrlToBlob(url) {
  const match = /^data:([^,;]*)([^,]*),/.exec(url);
  if (!match) throw new BoardFileError("A picture in that file is damaged.");
  const body = url.slice(match[0].length);
  let bytes;
  if (match[2].endsWith(";base64")) {
    const binary = atob(body);
    bytes = new Uint8Array(binary.length);
    for (let index = 0; index < binary.length; index += 1) bytes[index] = binary.charCodeAt(index);
  } else {
    bytes = new TextEncoder().encode(decodeURIComponent(body));
  }
  return new Blob([bytes], { type: match[1] || "application/octet-stream" });
}

/**
 * Copies of `elements` with new ids, moved so that together they're centred
 * on `center` (board coordinates), keeping their layout and order.
 */
export function placeElements(elements, center) {
  const bounds = getSceneBounds(elements);
  const dx = bounds ? center.x - (bounds.x + bounds.width / 2) : 0;
  const dy = bounds ? center.y - (bounds.y + bounds.height / 2) : 0;
  // Connectors stay attached to the copies of their shapes.
  return copyGroup(elements, elements, dx, dy, { sameLook: true });
}
