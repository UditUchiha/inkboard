import http from "node:http";
import { MongoMemoryServer } from "mongodb-memory-server";
import mongoose from "mongoose";
import { io as connectSocket } from "socket.io-client";

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
]) {
  process.env[key] = "";
}

const { createApp } = await import("../src/app.js");
const { signToken } = await import("../src/lib/tokens.ts");
const { User } = await import("../src/models/user.model.ts");
const { attachRealtime, flushAllSessions } = await import("../src/realtime/index.js");

const wait = (ms) => new Promise((resolve) => setTimeout(resolve, ms));

/** Polls until `check` returns something truthy, so tests wait for what they need instead of sleeping. */
export async function eventually(check, { timeout = 3000, interval = 25, message = "condition" } = {}) {
  const deadline = Date.now() + timeout;
  for (;;) {
    const value = await check();
    if (value) return value;
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
export const roundTrip = (client) => client.op("no-board", { upsert: [], remove: [] });

// Small element factories. Shapes match what the client creates.
export const rect = (id, x = 0, y = 0) => ({
  id,
  type: "rectangle",
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
export const upsert = (...elements) => ({ upsert: elements, remove: [] });
export const remove = (...ids) => ({ upsert: [], remove: ids });

/**
 * Starts the real app (REST and sockets) on a free port against a throwaway
 * in-memory MongoDB. Each test file gets its own, so files can run in parallel.
 */
export async function startServer() {
  const mongo = await MongoMemoryServer.create();
  await mongoose.connect(mongo.getUri("inkboard-test"));
  const server = http.createServer(createApp());
  const io = attachRealtime(server);
  await new Promise((resolve) => server.listen(0, "127.0.0.1", resolve));
  const url = `http://127.0.0.1:${server.address().port}`;
  const open = new Set();
  let counter = 0;

  async function request(path, { method = "GET", user, body } = {}) {
    const response = await fetch(`${url}/api${path}`, {
      method,
      headers: {
        "Content-Type": "application/json",
        ...(user ? { Authorization: `Bearer ${user.token}` } : {}),
      },
      body: body === undefined ? undefined : JSON.stringify(body),
    });
    const data = response.status === 204 ? null : await response.json().catch(() => null);
    return { status: response.status, data };
  }

  /**
   * Creates an account directly in the database and returns it with a login token.
   * Going around /auth/register keeps tests fast (no password hashing) and clear of
   * the sign-up rate limit; the register and login routes have their own tests.
   * The address counts as verified unless `verified: false` is passed.
   */
  async function signUp(name = "Person", { verified = true } = {}) {
    counter += 1;
    const email = `${name.toLowerCase().replace(/\W+/g, "")}-${counter}@example.test`;
    const user = await User.create({ name, email, emailVerified: verified });
    return { ...user.toPublic(), token: signToken(user), email };
  }

  async function createBoard(user, title = "A board") {
    const { status, data } = await request("/boards", { method: "POST", user, body: { title } });
    if (status !== 201) throw new Error(`Could not create board: ${status}`);
    return data.board.id;
  }

  /**
   * Opens a socket as `user` (or as a guest when null). It records every event,
   * so tests can assert on what arrived and when.
   */
  async function connect(user = null, { guest } = {}) {
    const socket = connectSocket(url, {
      auth: user ? { token: user.token } : { guest },
      transports: ["websocket"],
      reconnection: false,
    });
    open.add(socket);
    const events = [];
    socket.onAny((name, payload) => events.push({ name, payload }));
    await new Promise((resolve, reject) => {
      socket.once("connect", resolve);
      socket.once("connect_error", reject);
    });

    const client = {
      socket,
      events,
      of: (name) => events.filter((event) => event.name === name).map((event) => event.payload),
      last: (name) => client.of(name).at(-1),
      // `sync`: which merge rules the app says it follows (see SYNC_FORMAT); left out, an older app's.
      join: (boardId, { sync } = {}) => new Promise((resolve) => socket.emit("board:join", { boardId, sync }, resolve)),
      leave: () => socket.emit("board:leave"),
      image: (boardId, data, small) =>
        new Promise((resolve) => socket.emit("board:image", { boardId, data, small }, resolve)),
      op: (boardId, op) => new Promise((resolve) => socket.emit("board:op", { boardId, op }, resolve)),
      close: () => socket.disconnect(),
    };
    return client;
  }

  async function stop() {
    for (const socket of open) socket.disconnect();
    await flushAllSessions();
    await new Promise((resolve) => io.close(resolve)); // also closes the HTTP server
    await mongoose.disconnect();
    await mongo.stop();
  }

  return { url, request, signUp, createBoard, connect, stop };
}
