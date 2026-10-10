import { stampOf } from "@inkboard/shared/board-merge";
import type { Element as BoardElement, Effect } from "@inkboard/shared/types";
import type { Socket } from "socket.io-client";
import type { CreateBoardInput } from "../../lib/api";
import { SYNC_FORMAT } from "./constants";
import type { Scratch } from "./scratch";
import { toOperations } from "./store";

// Turning a guest's scratch board into a real board. Creating a board over HTTP
// takes a body of up to 2 MB, and a drawing can be much bigger, so what doesn't
// fit in the first request goes over the socket, as it would be if drawn on the board.

const FIRST_REQUEST_BYTES = 1_200_000;
const REPLY_TIMEOUT_MS = 20_000;
const CONNECT_TIMEOUT_MS = 10_000;

/** The board that importing made, of which only the id is read. */
export type ImportedBoard = { id: string };

/** What importScratch takes: the drawing, how to make a board and reach the server, and what an earlier try made. */
export type ImportOptions = {
  scratch: Scratch;
  createBoard: (input: CreateBoardInput) => Promise<unknown>;
  socket: Socket;
  created?: ImportedBoard | null;
  onCreated?: (board: ImportedBoard) => void;
};

// What the server answers to an event: whether it went through, and when joining a board, what it holds.
type Reply = { ok?: boolean; status?: number; board?: { elements?: BoardElement[] } };

export class ImportError extends Error {}

// The board an earlier try made is gone (deleted meanwhile): a new one is made instead.
class BoardGone extends Error {}

const ask = (socket: Socket, event: string, payload: unknown): Promise<Reply | null> =>
  new Promise((resolve) => {
    socket
      .timeout(REPLY_TIMEOUT_MS)
      .emit(event, payload, (error: Error | null, response: Reply) => resolve(error ? null : response));
  });

function connected(socket: Socket): Promise<void> {
  if (socket.connected) return Promise.resolve();
  return new Promise((resolve, reject) => {
    const timer = setTimeout(() => {
      socket.off("connect", onConnect);
      reject(new ImportError("Couldn't reach the server. Check your connection and try again."));
    }, CONNECT_TIMEOUT_MS);
    const onConnect = () => {
      clearTimeout(timer);
      resolve();
    };
    socket.once("connect", onConnect);
  });
}

// Sends `operations` to the board. With `keep` (the ids in the drawing), elements the board has that
// the drawing doesn't any more (removed since an earlier try uploaded them) are removed too.
async function sendPieces(
  socket: Socket,
  boardId: string,
  operations: Effect[],
  keep: Set<string> | null = null,
): Promise<void> {
  await connected(socket);
  const joined = await ask(socket, "board:join", { boardId, sync: SYNC_FORMAT });
  if (joined?.status === 404) throw new BoardGone();
  if (!joined?.ok) throw new ImportError("The rest of your drawing couldn't be uploaded.");
  const remove = keep
    ? (joined.board?.elements ?? [])
        .filter((element) => !keep.has(element.id))
        .map((element) => ({ id: element.id, version: stampOf(element).version + 1, versionNonce: 0 }))
    : [];
  try {
    for (const op of remove.length > 0 ? [...operations, { upsert: [], remove }] : operations) {
      const reply = await ask(socket, "board:op", { boardId, op });
      if (!reply?.ok) throw new ImportError("The rest of your drawing couldn't be uploaded.");
    }
  } finally {
    socket.emit("board:leave");
  }
}

/**
 * Saves `scratch` ({ title, elements }) as a new board and resolves with it.
 * `created` is a board an earlier try already made: it's filled in rather than
 * making another. `onCreated(board)` is told when one is made.
 */
export async function importScratch({
  scratch,
  createBoard,
  socket,
  created = null,
  onCreated = () => {},
}: ImportOptions): Promise<ImportedBoard> {
  const operations = toOperations(
    new Map(scratch.elements.map((element) => [element.id, element])),
    FIRST_REQUEST_BYTES,
  );
  if (created) {
    // The drawing may have changed since that try (the person went back to it), so all of it is
    // sent, and what's no longer in it removed. Sending a piece again is harmless: changes merge by
    // their stamps.
    try {
      await sendPieces(socket, created.id, operations, new Set(scratch.elements.map((element) => element.id)));
      return created;
    } catch (error) {
      if (!(error instanceof BoardGone)) throw error;
    }
  }
  const [first, ...rest] = operations;
  // The cast: the API says nothing of what it answers with, and it is the board that was made.
  const { board } = (await createBoard({ title: scratch.title, elements: first?.upsert ?? [] })) as {
    board: ImportedBoard;
  };
  onCreated(board);
  if (rest.length > 0) await sendPieces(socket, board.id, rest);
  return board;
}
