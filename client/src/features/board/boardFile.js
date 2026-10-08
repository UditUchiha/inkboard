import { getSceneBounds, newId, translate } from "./elements";

// A board saved as a file (.inkboard.json): its elements, plus the pictures on
// it as data URLs so the file stands on its own. Importing adds the elements to
// the open board with new ids, and uploads the pictures again so they belong
// to that board.

export const BOARD_FILE_TYPE = "inkboard";
export const BOARD_FILE_VERSION = 1;
export const BOARD_FILE_EXTENSION = ".inkboard.json";

const ELEMENT_TYPES = new Set(["pen", "line", "arrow", "rectangle", "ellipse", "text", "image"]);

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

/** Reads a board file's text. Returns `{ title, elements, pictures }` or throws a BoardFileError. */
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
  // The server checks every element properly; this just skips anything that isn't one.
  const elements = data.elements.filter(
    (element) =>
      element && typeof element === "object" && typeof element.id === "string" && ELEMENT_TYPES.has(element.type),
  );
  if (elements.length === 0) throw new BoardFileError("That board file is empty.");

  const pictures = new Map();
  for (const [id, url] of Object.entries(data.images ?? {})) {
    if (typeof url === "string" && url.startsWith("data:image/")) pictures.set(id, url);
  }
  return { title: typeof data.title === "string" ? data.title : "", elements, pictures };
}

/**
 * Copies of `elements` with new ids, moved so that together they're centred
 * on `center` (board coordinates), keeping their layout and order.
 */
export function placeElements(elements, center) {
  const bounds = getSceneBounds(elements);
  const dx = bounds ? center.x - (bounds.x + bounds.width / 2) : 0;
  const dy = bounds ? center.y - (bounds.y + bounds.height / 2) : 0;
  return elements.map((element) => ({ ...translate(element, dx, dy), id: newId() }));
}
