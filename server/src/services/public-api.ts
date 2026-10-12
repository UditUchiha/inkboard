import type { OpReply } from "@inkboard/shared/socket";
import type { Element } from "@inkboard/shared/types";
import { HttpError } from "../lib/http-error.ts";
import { Board } from "../models/board.model.ts";
import { applyOperation } from "../realtime/index.ts";
import { ApiElementError, fromApiElement, MAX_API_ELEMENTS, toApiElement } from "@inkboard/shared/api-elements";
import { canEdit, currentElements, findBoardForViewing, roleOf, withRoom } from "./boards.ts";

// What the public API and the MCP server do (see docs/api.md), for the person whose token it is. Each works like
// the app: the same access rules, and changes go through the same checks and merging as a browser's and reach
// everyone on the board at once (see applyOperation).

const MAX_TITLE_LENGTH = 80;

// Why a change was refused, for the person who sent it.
const REFUSED: Record<string, [status: number, message: string]> = {
  invalid: [400, "The change couldn't be read."],
  tooLarge: [413, "That would make the board bigger than a board can be."],
  ownerFull: [403, "The board's owner has used up their space."],
  forbidden: [403, "You can only view this board."],
};

function refuse(reply: OpReply): asserts reply is OpReply & { ok: true } {
  if (reply.ok) return;
  const [status, message] = REFUSED[reply.reason] ?? [503, "The board couldn't take the change. Try again."];
  throw new HttpError(status, message);
}

/** The boards the person owns or was invited to, most recently changed first. */
export async function listBoards(userId: string) {
  const boards = await Board.find({ deletedAt: null, $or: [{ owner: userId }, { collaborators: userId }] })
    .select("title owner updatedAt")
    .sort({ updatedAt: -1 })
    .lean();
  return boards.map((board) => ({
    id: String(board._id),
    title: board.title,
    role: String(board.owner) === userId ? "owner" : "editor",
    updatedAt: board.updatedAt,
  }));
}

/** A new, empty board the person owns. */
export async function createBoard(userId: string, title: unknown) {
  const name = typeof title === "string" ? title.trim().slice(0, MAX_TITLE_LENGTH) : "";
  const board = await withRoom(userId, { board: true }, () =>
    Board.create({ title: name || "Untitled board", owner: userId }),
  );
  return { id: board.id, title: board.title, role: "owner" };
}

// The board, if the person may open it, and what they may do there.
async function open(userId: string, boardId: string) {
  const board = await findBoardForViewing(boardId, userId);
  return { board, role: roleOf(board, userId) };
}

/** The board's details and its elements, as the API shows them. */
export async function readBoard(userId: string, boardId: string) {
  const { board, role } = await open(userId, boardId);
  const elements = await currentElements(board.id);
  return { id: board.id, title: board.title, role, elements: elements.map(toApiElement) };
}

// The board, if the person may change it.
async function openForEditing(userId: string, boardId: string) {
  const opened = await open(userId, boardId);
  if (!canEdit(opened.role)) throw new HttpError(403, "You can only view this board.");
  return opened.board;
}

/**
 * Adds elements to the board, or changes ones it has (an element with the id of one on the board changes just the
 * fields given). Returns them as the board now has them, and the ids of new ones it had no room for.
 */
export async function writeElements(userId: string, boardId: string, inputs: unknown) {
  if (!Array.isArray(inputs) || inputs.length === 0) throw new HttpError(400, "Send `elements`, a list of elements.");
  if (inputs.length > MAX_API_ELEMENTS) throw new HttpError(400, `Send at most ${MAX_API_ELEMENTS} elements at once.`);
  const board = await openForEditing(userId, boardId);
  const onBoard = new Map((await currentElements(board.id)).map((element) => [element.id, element]));
  const made = new Map<string, Element>();
  const find = (id: string) => made.get(id) ?? onBoard.get(id);
  inputs.forEach((input, at) => {
    const id = (input as { id?: unknown } | null)?.id;
    try {
      const element = fromApiElement(
        input,
        typeof id === "string" ? onBoard.get(id) : undefined,
        find,
        `Element ${at + 1}`,
      );
      made.set(element.id, element);
    } catch (error) {
      throw error instanceof ApiElementError ? new HttpError(400, error.message) : error;
    }
  });

  const { reply, session } = await applyOperation(board.id, { upsert: [...made.values()], remove: [] });
  refuse(reply);
  const dropped = new Set(reply.dropped);
  const elements = [...made.keys()].filter((id) => !dropped.has(id)).map((id) => session.index.get(id));
  return { elements: elements.filter(Boolean).map((element) => toApiElement(element!)), dropped: [...dropped] };
}

/** Removes elements from the board. Ids it doesn't have are let be. Returns the ids it removed. */
export async function removeElements(userId: string, boardId: string, ids: unknown) {
  if (!Array.isArray(ids) || ids.length === 0 || !ids.every((id) => typeof id === "string")) {
    throw new HttpError(400, "Send `ids`, a list of element ids.");
  }
  if (ids.length > MAX_API_ELEMENTS) throw new HttpError(400, `Send at most ${MAX_API_ELEMENTS} ids at once.`);
  const board = await openForEditing(userId, boardId);
  const onBoard = new Set((await currentElements(board.id)).map((element) => element.id));
  const removing = [...new Set(ids as string[])].filter((id) => onBoard.has(id));
  if (removing.length > 0) refuse((await applyOperation(board.id, { upsert: [], remove: removing })).reply);
  return { removed: removing };
}
