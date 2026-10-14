import http from "node:http";
import type { AddressInfo } from "node:net";
import { MongoMemoryServer } from "mongodb-memory-server";
import mongoose from "mongoose";
import { io as connectSocket } from "socket.io-client";
import type { Socket } from "socket.io-client";
import type { BoardDetails, LinkLock, PublicUser } from "@inkboard/shared/api";
import type {
  ImageLimit,
  OpRefusal,
  RemovedStamp,
  ServerToClientEvents,
  SuggestionRefusal,
} from "@inkboard/shared/socket";
import type { Suggestion } from "@inkboard/shared/suggestions";
import type { SYNC_FORMAT } from "@inkboard/shared/limits";
import type { Element, Operation, ShapeElement } from "@inkboard/shared/types";
import type { FullOperation } from "../src/realtime/operations.ts";

process.env.NODE_ENV ??= "test";
// Tests must not depend on whatever is in a developer's server/.env. Variables already set win over
// that file, so blanking these keeps social sign-in "not configured", emails unsent (kept in the
// outbox), links built from each request's address and CORS at its default for every test.
for (const key of [
  "GOOGLE_CLIENT_ID",
  "GOOGLE_CLIENT_SECRET",
  "GITHUB_CLIENT_ID",
  "GITHUB_CLIENT_SECRET",
  "BREVO_API_KEY",
  "EMAIL_FROM",
  "EMAIL_FROM_NAME",
  "EMAIL_DAILY_LIMIT",
  "APP_URL",
  "API_URL",
  "CLIENT_ORIGIN",
  "TRUST_PROXY",
  "JWT_EXPIRES_IN",
  "R2_ACCOUNT_ID",
  "R2_ACCESS_KEY_ID",
  "R2_SECRET_ACCESS_KEY",
  "R2_BUCKET",
]) {
  process.env[key] = "";
}

const { createApp } = await import("../src/app.ts");
const { signToken } = await import("../src/lib/tokens.ts");
const { User } = await import("../src/models/user.model.ts");
const { attachRealtime, flushAllSessions } = await import("../src/realtime/index.ts");

const wait = (ms: number) => new Promise((resolve) => setTimeout(resolve, ms));

export interface TestUser extends PublicUser {
  token: string;
}

export interface RequestOptions {
  method?: string;
  user?: { token: string };
  body?: unknown;
}

export type EventPayload<E extends keyof ServerToClientEvents> = Parameters<ServerToClientEvents[E]>[0];

export interface SocketEvent {
  name: string;
  payload: unknown;
}

export type TestJoinReply = {
  ok: boolean;
  status?: number;
  error?: string;
  locked?: LinkLock;
  board: BoardDetails;
  removed: RemovedStamp[];
  suggestions: Suggestion[];
};

export type TestSuggestReply = {
  ok: boolean;
  reason?: SuggestionRefusal["reason"];
  suggestions?: Suggestion[];
  withdrawn?: string[];
  dropped?: string[];
  full?: "board" | "author";
};

export type TestOpReply = {
  ok: boolean;
  reason?: OpRefusal["reason"];
  cleaned?: Element[];
  dropped?: string[];
  tooLarge?: true;
  readOnly?: true;
  error?: string;
};

export type TestImageReply = {
  ok: boolean;
  id: string;
  error?: string;
  readOnly?: true;
  tooLarge?: true;
  full?: ImageLimit;
};

export interface TestClient {
  socket: Socket;
  events: SocketEvent[];
  of<E extends keyof ServerToClientEvents>(name: E): EventPayload<E>[];
  of(name: string): unknown[];
  last<E extends keyof ServerToClientEvents>(name: E): EventPayload<E> | undefined;
  last(name: string): unknown;
  join: (boardId: string, options?: { sync?: typeof SYNC_FORMAT; pass?: string }) => Promise<TestJoinReply>;
  leave: () => void;
  image: (boardId: string, data: unknown, small?: unknown) => Promise<TestImageReply>;
  op: (boardId: string, op: unknown) => Promise<TestOpReply>;
  // Suggestions (see src/realtime/suggestions.ts): make or replace some, take some back, accept or reject some.
  suggest: (boardId: string, drafts: unknown) => Promise<TestSuggestReply>;
  withdraw: (boardId: string, ids: unknown) => Promise<TestSuggestReply>;
  resolve: (boardId: string, ids: unknown, outcome: unknown) => Promise<TestSuggestReply>;
  close: () => void;
}

export interface ServerInstance {
  url: string;
  request: <T = Record<string, unknown>>(
    path: string,
    options?: RequestOptions,
  ) => Promise<{ status: number; data: T }>;
  signUp: (name?: string, options?: { verified?: boolean }) => Promise<TestUser>;
  createBoard: (user: { token: string }, title?: string) => Promise<string>;
  connect: (user?: { token: string } | null, options?: { guest?: unknown }) => Promise<TestClient>;
  stop: () => Promise<void>;
}

/** Polls until `check` returns something truthy, so tests wait for what they need instead of sleeping. */
export async function eventually<T>(
  check: () => Promise<T> | T,
  {
    timeout = 3000,
    interval = 25,
    message = "condition",
  }: { timeout?: number; interval?: number; message?: string } = {},
): Promise<NonNullable<T>> {
  const deadline = Date.now() + timeout;
  for (;;) {
    const value = await check();
    if (value) return value as NonNullable<T>;
    if (Date.now() > deadline) throw new Error(`Timed out waiting for ${message}`);
    await wait(interval);
  }
}

/**
 * A round trip on `client`'s socket, for asserting that something did NOT arrive without sleeping. The server
 * answers after everything it sent that socket earlier (one connection delivers in order), so once this resolves,
 * whatever the server had already emitted to the client is in `client.events`. (The request names no board, so it
 * changes nothing; the reply is "noSession".)
 */
export const roundTrip = (client: TestClient) => client.op("no-board", { upsert: [], remove: [] });

// Small element factories. Shapes match what the client creates.
export const rect = (id: string, x = 0, y = 0): ShapeElement => ({
  id,
  type: "rectangle" as const,
  seed: 1,
  x1: x,
  y1: y,
  x2: x + 100,
  y2: y + 60,
  stroke: "#16213a",
  fill: null,
  strokeWidth: 2.5,
  sketchy: true,
});
export const upsert = (...elements: unknown[]): FullOperation => ({ upsert: elements as Element[], remove: [] });
export const remove = (...ids: string[]): Operation => ({ upsert: [], remove: ids });

// A test guest's key: the same for the same id, as a browser keeps it.
function withKey(guest: unknown) {
  const { id, key } = (guest ?? {}) as { id?: unknown; key?: unknown };
  return typeof id === "string" && key === undefined ? { ...(guest as object), key: `${id}-test-key-123` } : guest;
}

/**
 * Starts the real app (REST and sockets) on a free port against a throwaway
 * in-memory MongoDB. Each test file gets its own, so files can run in parallel.
 */
export async function startServer(): Promise<ServerInstance> {
  const mongo = await MongoMemoryServer.create();
  await mongoose.connect(mongo.getUri("inkboard-test"));
  const server = http.createServer(createApp());
  const io = attachRealtime(server);
  await new Promise((resolve) => server.listen(0, "127.0.0.1", resolve as () => void));
  const url = `http://127.0.0.1:${(server.address() as AddressInfo).port}`;
  const open = new Set<Socket>();
  let counter = 0;

  async function request<T = Record<string, unknown>>(
    path: string,
    { method = "GET", user, body }: RequestOptions = {},
  ): Promise<{ status: number; data: T }> {
    const response = await fetch(`${url}/api${path}`, {
      method,
      headers: {
        "Content-Type": "application/json",
        ...(user ? { Authorization: `Bearer ${user.token}` } : {}),
      },
      body: body === undefined ? undefined : JSON.stringify(body),
    });
    const data = (response.status === 204 ? null : await response.json().catch(() => null)) as T;
    return { status: response.status, data };
  }

  /**
   * Creates an account directly in the database and returns it with a login token.
   * Going around /auth/register keeps tests fast (no password hashing) and clear of
   * the sign-up rate limit; the register and login routes have their own tests.
   * The address counts as verified unless `verified: false` is passed.
   */
  async function signUp(name = "Person", { verified = true }: { verified?: boolean } = {}): Promise<TestUser> {
    counter += 1;
    const email = `${name.toLowerCase().replace(/\W+/g, "")}-${counter}@example.test`;
    const user = await User.create({ name, email, emailVerified: verified });
    return { ...user.toPublic(), token: signToken(user), email };
  }

  async function createBoard(user: { token: string }, title = "A board"): Promise<string> {
    const { status, data } = await request<{ board: { id: string } }>("/boards", {
      method: "POST",
      user,
      body: { title },
    });
    if (status !== 201) throw new Error(`Could not create board: ${status}`);
    return data.board.id;
  }

  /**
   * Opens a socket as `user` (or as a guest when null). It records every event,
   * so tests can assert on what arrived and when.
   */
  async function connect(
    user: { token: string } | null = null,
    { guest }: { guest?: unknown } = {},
  ): Promise<TestClient> {
    const socket = connectSocket(url, {
      // A guest with an id comes with the key that id is theirs by (see guestIdentity), unless the test gives one.
      auth: user ? { token: user.token } : { guest: withKey(guest) },
      transports: ["websocket"],
      reconnection: false,
    });
    open.add(socket);
    const events: SocketEvent[] = [];
    socket.onAny((name: string, payload: unknown) => events.push({ name, payload }));
    await new Promise((resolve, reject) => {
      socket.once("connect", resolve as () => void);
      socket.once("connect_error", reject);
    });

    const client: TestClient = {
      socket,
      events,
      of: ((name: string) =>
        events.filter((event) => event.name === name).map((event) => event.payload)) as TestClient["of"],
      last: ((name: string) => client.of(name).at(-1)) as TestClient["last"],
      // `sync`: which merge rules the app says it follows (see SYNC_FORMAT); left out, an older app's.
      // `pass`: the pass for the link's password (see link-pass.ts).
      join: (boardId: string, { sync, pass }: { sync?: typeof SYNC_FORMAT; pass?: string } = {}) =>
        new Promise((resolve) => socket.emit("board:join", { boardId, sync, pass }, resolve)),
      leave: () => socket.emit("board:leave"),
      image: (boardId: string, data: unknown, small?: unknown) =>
        new Promise((resolve) => socket.emit("board:image", { boardId, data, small }, resolve)),
      op: (boardId: string, op: unknown) => new Promise((resolve) => socket.emit("board:op", { boardId, op }, resolve)),
      suggest: (boardId: string, suggestions: unknown) =>
        new Promise((resolve) => socket.emit("suggestion:put", { boardId, suggestions }, resolve)),
      withdraw: (boardId: string, ids: unknown) =>
        new Promise((resolve) => socket.emit("suggestion:withdraw", { boardId, ids }, resolve)),
      resolve: (boardId: string, ids: unknown, outcome: unknown) =>
        new Promise((resolve) => socket.emit("suggestion:resolve", { boardId, ids, outcome }, resolve)),
      close: () => socket.disconnect(),
    };
    return client;
  }

  async function stop(): Promise<void> {
    for (const socket of open) socket.disconnect();
    await flushAllSessions();
    await new Promise((resolve) => io.close(resolve as () => void)); // also closes the HTTP server
    await mongoose.disconnect();
    await mongo.stop();
  }

  return { url, request, signUp, createBoard, connect, stop };
}
