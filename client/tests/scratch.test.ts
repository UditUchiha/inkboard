import assert from "node:assert/strict";
import { describe, it } from "node:test";
import type { Element, Operation } from "@inkboard/shared/types";
import type { CreateBoardInput } from "../src/lib/api.ts";
import type { AppSocket } from "../src/providers/SocketProvider.tsx";
import type { ImportedBoard, ImportOptions } from "../src/features/board/scratchImport.ts";

// A stand-in for the browser's localStorage, which can be made to run out of room.
const storage = {
  data: new Map<string, string>(),
  full: false,
  getItem(key: string) {
    return this.data.get(key) ?? null;
  },
  setItem(key: string, value: unknown) {
    if (this.full) throw new Error("QuotaExceededError");
    this.data.set(key, String(value));
  },
  removeItem(key: string) {
    this.data.delete(key);
  },
};
globalThis.localStorage = storage as unknown as Storage;

const { clearScratch, currentScratch, readScratch } = await import("../src/features/board/scratch.ts");
const { importScratch } = await import("../src/features/board/scratchImport.ts");

const rect = (id: string, extra: Record<string, unknown> = {}): Element =>
  ({ id, type: "rectangle", x1: 0, y1: 0, x2: 10, y2: 10, ...extra }) as unknown as Element;

describe("reading the saved scratch board", () => {
  it("leaves out anything that isn't a valid element, so it can't break drawing", () => {
    storage.setItem(
      "inkboard.scratch",
      JSON.stringify({
        title: "Mine",
        elements: [rect("a"), { id: "p", type: "pen" }, { id: "t", type: "text", text: 5 }],
      }),
    );
    const scratch = readScratch();
    assert.equal(scratch.title, "Mine");
    assert.deepEqual(
      scratch.elements.map((element: Element) => element.id),
      ["a"],
    );
    clearScratch();
    assert.deepEqual(currentScratch().elements, []);
  });
});

/** A socket that answers like the server: joins and ops are acknowledged, and what was sent is kept. */
function fakeSocket({ refuseOps = false }: { refuseOps?: boolean } = {}) {
  const sent: [string, { op: Operation }][] = [];
  const socket = {
    connected: true,
    sent,
    timeout: () => socket,
    emit(event: string, payload: unknown, reply?: (error: Error | null, response?: unknown) => void) {
      sent.push([event, payload as { op: Operation }]);
      reply?.(null, event === "board:op" && refuseOps ? { ok: false, reason: "tooLarge" } : { ok: true });
    },
  };
  return socket as unknown as AppSocket & { sent: [string, { op: Operation }][] };
}

describe("saving a scratch board to an account", () => {
  const big = (id: string) => rect(id, { text: "x".repeat(700_000) });

  it("sends a small drawing in the request that makes the board", async () => {
    const requests: CreateBoardInput[] = [];
    const socket = fakeSocket();
    const board = await importScratch({
      scratch: { title: "T", elements: [rect("a"), rect("b")] },
      createBoard: async (input: CreateBoardInput) => (requests.push(input), { board: { id: "board1" } }),
      socket,
    });
    assert.equal(board.id, "board1");
    assert.equal(requests[0]!.elements!.length, 2);
    assert.equal(socket.sent.length, 0);
  });

  it("sends what doesn't fit in the request over the socket, so a big drawing can be saved", async () => {
    const requests: CreateBoardInput[] = [];
    const socket = fakeSocket();
    await importScratch({
      scratch: { title: "T", elements: [big("a"), big("b"), big("c")] },
      createBoard: async (input: CreateBoardInput) => (requests.push(input), { board: { id: "board1" } }),
      socket,
    });
    assert.ok(JSON.stringify(requests[0]).length < 1_500_000, "the request stays under the server's 2 MB limit");
    const ops = socket.sent.filter(([event]) => event === "board:op");
    const ids = [...requests[0]!.elements!, ...ops.flatMap(([, { op }]) => op.upsert!)].map((element) => element.id);
    assert.deepEqual(ids.sort(), ["a", "b", "c"]);
    assert.equal(socket.sent[0]![0], "board:join");
    assert.equal(socket.sent.at(-1)![0], "board:leave");
  });

  it("fills in the board an earlier try made instead of making another", async () => {
    const socket = fakeSocket();
    let made = 0;
    const board = await importScratch({
      scratch: { title: "T", elements: [big("a"), big("b"), big("c")] },
      createBoard: (async () => (made += 1)) as unknown as ImportOptions["createBoard"],
      socket,
      created: { id: "board1" },
    });
    assert.equal(made, 0);
    assert.equal(board.id, "board1");
    assert.ok(socket.sent.some(([event]) => event === "board:op"));
  });

  it("fails, and leaves the board, if the server refuses the rest", async () => {
    const socket = fakeSocket({ refuseOps: true });
    await assert.rejects(
      importScratch({
        scratch: { title: "T", elements: [big("a"), big("b"), big("c")] },
        createBoard: async () => ({ board: { id: "board1" } }),
        socket,
      }),
      /couldn't be uploaded/,
    );
    assert.equal(socket.sent.at(-1)![0], "board:leave");
  });
});

describe("saving a scratch board again after a try that failed", () => {
  // A socket whose join answers `joined`, and which acknowledges every change.
  function boardSocket(joined: unknown) {
    const sent: [string, { op: Operation }][] = [];
    const socket = {
      connected: true,
      sent,
      timeout: () => socket,
      emit(event: string, payload: unknown, reply?: (error: Error | null, response?: unknown) => void) {
        sent.push([event, payload as { op: Operation }]);
        reply?.(null, event === "board:join" ? joined : { ok: true });
      },
    };
    return socket as unknown as AppSocket & { sent: [string, { op: Operation }][] };
  }
  const ops = (socket: ReturnType<typeof boardSocket>) =>
    socket.sent.filter(([event]) => event === "board:op").map(([, { op }]) => op);

  it("fills in the same board with the drawing as it is now, all of it, removing what was rubbed out", async () => {
    // The first try made the board with a, b and gone; then the person went back and changed the drawing.
    const elements = [rect("a"), rect("b"), rect("gone", { version: 4 })];
    const socket = boardSocket({ ok: true, board: { elements } });
    let made = 0;
    const board = await importScratch({
      scratch: { title: "T", elements: [rect("a", { x2: 50 }), rect("b"), rect("new")] },
      createBoard: (async () => (made += 1)) as unknown as ImportOptions["createBoard"],
      socket,
      created: { id: "board1" },
    });
    assert.equal(made, 0, "no second board");
    assert.equal(board.id, "board1");
    const sent = ops(socket);
    assert.deepEqual(sent.flatMap((op) => op.upsert!.map((element) => element.id)).sort(), ["a", "b", "new"]);
    assert.deepEqual(
      sent.flatMap((op) => op.remove!),
      [{ id: "gone", version: 5, versionNonce: 0 }],
    );
  });

  it("makes a new board when the one an earlier try made was deleted since", async () => {
    const socket = boardSocket({ ok: false, status: 404 });
    const made: (CreateBoardInput | string)[] = [];
    const board = await importScratch({
      scratch: { title: "T", elements: [rect("a")] },
      createBoard: async (input: CreateBoardInput) => (made.push(input), { board: { id: "board2" } }),
      socket,
      created: { id: "board1" },
      onCreated: (created: ImportedBoard) => made.push(created.id),
    });
    assert.equal(board.id, "board2");
    assert.deepEqual(made.at(-1), "board2");
  });
});
