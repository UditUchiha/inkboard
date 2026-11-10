import { stampOf } from "@inkboard/shared/board-merge";
import type { JoinPayload, OpPayload } from "@inkboard/shared/socket";
import type { Element as BoardElement, Effect } from "@inkboard/shared/types";
import type { Socket } from "socket.io-client";
import type { CreateBoardInput } from "../../../../lib/api";
import type { AppSocket } from "../../../../providers/SocketProvider";
import { SYNC_FORMAT } from "../../constants/board";
import type { Scratch } from "./scratch";
import { toOperations } from "./store";

// Creating a board over HTTP takes a body of up to 2 MB and a drawing can be bigger, so what doesn't fit goes over the
// socket.

const FIRST_REQUEST_BYTES = 1_200_000;
const REPLY_TIMEOUT_MS = 20_000;
const CONNECT_TIMEOUT_MS = 10_000;

export type ImportedBoard = { id: string };

export type ImportOptions = {
  scratch: Scratch;
  createBoard: (input: CreateBoardInput) => Promise<{ board: ImportedBoard }>;
  socket: AppSocket;
  created?: ImportedBoard | null;
  onCreated?: (board: ImportedBoard) => void;
};

type Reply = { ok?: boolean; status?: number; board?: { elements?: BoardElement[] } };

export class ImportError extends Error {}

class BoardGone extends Error {}

type Ask = {
  (socket: AppSocket, event: "board:join", payload: JoinPayload): Promise<Reply | null>;
  (socket: AppSocket, event: "board:op", payload: OpPayload): Promise<Reply | null>;
};

// emit can't follow an event typed as one of two from signature to payload, so the overloads above do the checking.
const ask: Ask = (socket: AppSocket, event: "board:join" | "board:op", payload: JoinPayload | OpPayload) =>
  new Promise<Reply | null>((resolve) => {
    (socket.timeout(REPLY_TIMEOUT_MS) as Socket).emit(event, payload, (error: Error | null, response: Reply) =>
      resolve(error ? null : response),
    );
  });

function connected(socket: AppSocket): Promise<void> {
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

// With `keep`, elements the board has that the drawing no longer does (removed since an earlier try) are removed too.
async function sendPieces(
  socket: AppSocket,
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
    // The drawing may have changed since that try, so all of it is sent and the rest removed; resending is harmless as
    // changes merge by stamp.
    try {
      await sendPieces(socket, created.id, operations, new Set(scratch.elements.map((element) => element.id)));
      return created;
    } catch (error) {
      if (!(error instanceof BoardGone)) throw error;
    }
  }
  const [first, ...rest] = operations;
  const { board } = await createBoard({ title: scratch.title, elements: first?.upsert ?? [] });
  onCreated(board);
  if (rest.length > 0) await sendPieces(socket, board.id, rest);
  return board;
}
