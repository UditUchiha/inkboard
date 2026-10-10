import { cutText } from "@inkboard/shared/element-rules";
import { Server } from "socket.io";
import { env } from "../config/env.ts";
import { keyedQueue } from "../lib/keyed-queue.ts";
import { userForToken } from "../lib/tokens.ts";
import {
  canEdit,
  findBoardForViewing,
  isMemberRole,
  recordOpen,
  roleOf,
  roomLeft,
  serializeBoard,
  serializeMeta,
} from "../services/boards.js";
import { detectImageType, IMAGE_LIMITS, storeImage } from "../services/images.js";
import { effectOf, planOperation } from "@inkboard/shared/board-merge";
import {
  holdPiece,
  isOversized,
  MAX_GROUP_BYTES,
  prepareOperation,
  sanitizeOperation,
  SYNC_FORMAT,
} from "./operations.js";
import { createLimiter, LIMITS } from "./rate-limit.js";
import {
  acquireSession,
  admit,
  closeSession,
  discardSession,
  flushAllSessions,
  getSession,
  holdSession,
  removedStamps,
  resetSession,
  updateSession,
} from "./sessions.js";

let io;

export function attachRealtime(httpServer) {
  io = new Server(httpServer, {
    cors: { origin: env.clientOrigins },
    // Room for an uploaded image (up to IMAGE_LIMITS.image), its small copy, and the message around them.
    maxHttpBufferSize: 3e6,
    // Joining a big board sends megabytes of JSON, which compresses well. Small messages (cursors, most
    // changes) are left alone: they cost more to compress than they save.
    perMessageDeflate: { threshold: 4096, zlibDeflateOptions: { level: 1 } },
  });
  io.use(authenticate);
  io.on("connection", handleConnection);
  return io;
}

export { flushAllSessions };

/**
 * Shuts down: saves every open board, disconnects everyone (which saves whatever
 * was still being written as they leave), and saves again to be sure.
 */
export async function closeRealtime() {
  await flushAllSessions();
  await io?.close();
  await flushAllSessions();
}

// Replies that older browsers (still open during an update) understand too: they look for `tooLarge` and `readOnly`.
const TOO_LARGE = { ok: false, reason: "tooLarge", tooLarge: true };
const FORBIDDEN = { ok: false, reason: "forbidden", readOnly: true };
// Why a piece of a change sent in several was refused (see holdPiece). "expired": the server stopped
// waiting for the rest of its group, so the sender sends the whole change again.
const GROUP_REFUSED = {
  invalid: { ok: false, reason: "invalid" },
  tooLarge: TOO_LARGE,
  expired: { ok: false, reason: "expired" },
};

// The pieces of a change sent in several take memory until the last one arrives (see holdPiece). So a
// group whose next piece doesn't come for this long is let go, and what's held at once is capped for
// each sender (an account, or a guest's address: a guest can open as many connections as they like)
// and for the whole server. A piece past a cap is answered as if rate limited: the sender waits, then
// sends the whole change again.
const GROUP_IDLE_MS = 60_000;
const MAX_HELD_BYTES_PER_SENDER = 2 * MAX_GROUP_BYTES;
const MAX_HELD_BYTES = 4 * MAX_GROUP_BYTES;
const held = { total: 0, bySender: new Map() };

/**
 * Sets what `socket` holds of a group (`group`, as holdPiece returns it, or null for nothing), counting
 * the bytes held. Returns false, and holds nothing, when keeping `group` would go past a cap.
 */
function holdGroup(socket, group) {
  const { sender } = socket.data;
  const before = socket.data.heldGroup?.bytes ?? 0;
  const ofSender = held.bySender.get(sender) ?? 0;
  const growth = (group?.bytes ?? 0) - before;
  const fits = growth <= 0 || (held.total + growth <= MAX_HELD_BYTES && ofSender + growth <= MAX_HELD_BYTES_PER_SENDER);
  const kept = fits ? group : null;
  const change = (kept?.bytes ?? 0) - before;
  held.total += change;
  if (ofSender + change > 0) held.bySender.set(sender, ofSender + change);
  else held.bySender.delete(sender);
  socket.data.heldGroup = kept;
  clearTimeout(socket.data.heldTimer);
  socket.data.heldTimer = kept?.pieces ? setTimeout(() => expireGroup(socket), GROUP_IDLE_MS).unref() : null;
  return fits;
}

// Lets go of a group whose next piece is overdue. Its id is kept, so a piece of it that turns up
// later is told to send the whole change again rather than that it's invalid.
function expireGroup(socket) {
  const { id } = socket.data.heldGroup ?? {};
  holdGroup(socket, id ? { id, expired: true } : null);
}

// A change that would grow a board by more than its owner has space left for (BOARD_LIMITS in
// services/boards.js) is refused; changes that don't grow it are always taken. Adding up what an
// owner keeps reads all their boards, versions and templates, so it's done at most this often for each
// owner (not each open board: one owner with several boards open shares one figure), and growth taken
// in meanwhile is counted off what was left.
const ROOM_CHECK_MS = 30_000;
// Before a change is refused for lack of space, a figure older than this is looked up again, in case the
// owner has made room since.
const ROOM_REFRESH_MS = 3_000;
// After a lookup fails, the next change tries again once this long has passed.
const ROOM_RETRY_MS = 2_000;
// `tooLarge` is for browsers still running an older version of the app, which don't know "ownerFull" and
// would send the change again every moment for good: on `tooLarge` they undo it, as the current one does.
const OWNER_FULL = { ok: false, reason: "ownerFull", tooLarge: true };

// owner id -> { room, at, pending, boards }: the bytes the owner has left as last looked up (`room`, at
// time `at`; undefined until a lookup has worked), the lookup under way, and the owner's open boards
// (id -> session), which tell whether anything has kept the figure up to date since it was looked up.
const owners = new Map();

function ownerEntry(owner) {
  let entry = owners.get(owner);
  if (!entry) {
    // Anyone with nothing open any more is let go, so the map doesn't grow with every owner ever seen.
    if (owners.size > 1000) {
      for (const [id, other] of owners) if (!other.pending && Date.now() - other.at >= ROOM_CHECK_MS) owners.delete(id);
    }
    entry = { room: undefined, at: 0, pending: null, boards: new Map() };
    owners.set(owner, entry);
  }
  return entry;
}

/** Looks up what `owner` has left, or waits for the lookup already under way. Never rejects. */
function lookUpRoom(owner) {
  const entry = ownerEntry(owner);
  entry.pending ??= roomLeft(owner)
    .then(
      (left) => {
        entry.room = left;
        entry.at = Date.now();
      },
      (error) => {
        // The figure is left as it was (unknown, at first) and tried again soon, by the next change.
        entry.at = Date.now() - ROOM_CHECK_MS + ROOM_RETRY_MS;
        console.error(`Could not add up the space used by ${owner}: ${error.message}`);
      },
    )
    .finally(() => {
      entry.pending = null;
    });
  return entry.pending;
}

/**
 * Notes that `session`'s board is open, and looks up what its owner has left (waiting for it, unless it's
 * known and recent), so the first change drawn doesn't have to go without a figure. A figure kept while
 * none of the owner's boards were open is dropped: nothing kept it up to date.
 */
async function openOwner(session) {
  if (!session.owner) return;
  const entry = ownerEntry(session.owner);
  for (const [id, open] of entry.boards) if (getSession(id) !== open) entry.boards.delete(id);
  if (entry.boards.size === 0) entry.at = 0;
  entry.boards.set(session.boardId, session);
  if (Date.now() - entry.at >= ROOM_CHECK_MS) await lookUpRoom(session.owner);
}

/**
 * The bytes the owner of `session`'s board has left, as last looked up. Infinity when that isn't known
 * (no owner, or no lookup has worked yet: it is tried again, and this one change goes in; failing open
 * for a change or two beats refusing everything while the database is slow).
 */
function ownerRoom(session) {
  if (!session.owner) return Infinity;
  const entry = ownerEntry(session.owner);
  if (!entry.pending && Date.now() - entry.at >= ROOM_CHECK_MS) lookUpRoom(session.owner);
  return entry.room ?? Infinity;
}

/** How many bytes of unfinished groups connections hold right now, in all. */
export const heldGroupBytes = () => held.total;

// Joining and leaving a board run one after another for each connection (joining reads the
// database), so a quick join, leave, join can't leave a socket in two boards' rooms.
const turns = keyedQueue();

const GUEST_ID = /^g_[a-z0-9]{6,32}$/i;

export function cleanGuestName(value) {
  const name = cutText(
    String(value ?? "")
      .trim()
      .replace(/\s+/g, " "),
    40,
  );
  return name || "Guest";
}

// Connecting without a token is allowed: guests can open boards whose link is
// shared. They pick a name (and keep a random id) so others can see who they are.
async function authenticate(socket, next) {
  const { token, guest } = socket.handshake.auth ?? {};
  if (!token) {
    socket.data.user = null;
    socket.data.guest = {
      id: GUEST_ID.test(String(guest?.id ?? "")) ? guest.id : `g_${socket.id.replace(/[^a-z0-9]/gi, "")}`,
      name: cleanGuestName(guest?.name),
    };
    return next();
  }
  try {
    const { user } = await userForToken(token);
    socket.data.user = user.toPublic();
    next();
  } catch {
    next(new Error("unauthorized"));
  }
}

function personOf(socket) {
  const { user, guest } = socket.data;
  if (user) {
    return { userId: user.id, name: user.name, color: user.color, avatarUrl: user.avatarUrl, guest: false };
  }
  return { userId: guest.id, name: guest.name, color: null, avatarUrl: null, guest: true };
}

const finite = (value) => Number.isFinite(Number(value));

// The small copy sent with an image for thumbnails, or null. It's optional:
// without one, thumbnails show the image itself, so a bad one is just dropped.
function readSmallCopy(data) {
  if (!Buffer.isBuffer(data) || data.length > IMAGE_LIMITS.small) return null;
  const mime = detectImageType(data);
  return mime ? { buffer: data, mime } : null;
}

// Where a socket connected from, as far as the proxies in front of this server say (see TRUST_PROXY).
function addressOf(socket) {
  const hops = String(socket.handshake.headers["x-forwarded-for"] ?? "")
    .split(",")
    .map((hop) => hop.trim())
    .filter(Boolean);
  const { trustProxy } = env;
  if (trustProxy === true && hops.length > 0) return hops[0];
  if (typeof trustProxy === "number" && trustProxy > 0 && hops.length >= trustProxy) {
    return hops[hops.length - trustProxy];
  }
  return socket.handshake.address;
}

// Why an image didn't fit, for the person who tried to add it.
function spaceMessage(limit, role, unverified) {
  const freeing = "Pictures you remove free their space once no saved version of the board shows them.";
  if (limit === "board") return `This board is out of image space. ${freeing}`;
  if (limit === "owner") {
    if (role === "owner") {
      const verify = unverified ? " Confirm your email address (see Settings) to get more room." : "";
      return `Your boards are out of image space. ${freeing}${verify}`;
    }
    return "This board's owner is out of image space. Ask them to remove pictures they don't need.";
  }
  return "Image storage is full for now. Try again later.";
}

// Whether `claimed`, the board id in a message, is the board `socket` is on: its id as the database has
// it, or as the socket asked for it (upper case, say: a client may name a board in either).
function isOnBoard(socket, claimed) {
  const { boardId, requestedId } = socket.data;
  return Boolean(boardId) && (claimed === boardId || claimed === requestedId);
}

// Takes a change in, or refuses it, and replies. `refresh` says whether a refusal for lack of space
// may be checked against a newer figure first (it may be a little out of date): that look-up is the only
// wait, and the change is worked out again after it, from the board as it is then.
function takeOperation(socket, session, operation, reply, refresh) {
  const { boardId } = socket.data;
  if (isOversized(operation)) return reply(TOO_LARGE);
  const sanitized = sanitizeOperation(operation);
  if (!sanitized) return reply({ ok: false, reason: "invalid" });
  const op = prepareOperation(session.elements, sanitized, session.tombstones, {
    legacy: socket.data.legacy,
    index: session.index,
  });
  const plan = planOperation(session.elements, op, session.tombstones, { index: session.index, remember: false });
  // What actually changes: edits that newer ones already replaced are left out.
  // Others are sent each element as the server now has it, merged.
  const effect = effectOf(plan);
  const before = session.bytes;
  const room = ownerRoom(session);
  const refused = admit(
    session,
    { upsert: [...plan.shown.values()], remove: effect.remove },
    [...plan.buried.values()],
    room,
  );
  if (refused === "owner" && refresh && Date.now() - ownerEntry(session.owner).at > ROOM_REFRESH_MS) {
    lookUpRoom(session.owner).then(() => {
      // Nothing is taken in for a socket that left, or a board that closed, meanwhile.
      if (socket.data.boardId === boardId && getSession(boardId) === session) {
        takeOperation(socket, session, operation, reply, false);
      } else reply({ ok: false, reason: "noSession" });
    });
    return;
  }
  if (refused) return reply(refused === "owner" ? OWNER_FULL : TOO_LARGE);
  if (Number.isFinite(room)) ownerEntry(session.owner).room -= Math.max(0, session.bytes - before);

  const dropped = new Set(updateSession(session, plan));
  if (dropped.size > 0) effect.upsert = effect.upsert.filter((element) => !dropped.has(element.id));
  if (effect.upsert.length > 0 || effect.remove.length > 0) {
    socket.to(boardId).emit("board:op", { boardId, op: effect });
  }

  // The sender made these changes on its own screen, so it's told where the board differs.
  const cleaned = sanitized.changed;
  for (const id of sanitized.refused) {
    const stored = session.index.get(id);
    if (stored) cleaned.push(stored);
    else dropped.add(id);
  }
  reply({
    ok: true,
    ...(cleaned.length > 0 ? { cleaned } : {}),
    ...(dropped.size > 0 ? { dropped: [...dropped] } : {}),
  });
}

function handleConnection(socket) {
  const limits = Object.fromEntries(Object.entries(LIMITS).map(([name, limit]) => [name, createLimiter(limit)]));
  // Whom the memory held for its unfinished groups counts against (see holdGroup).
  socket.data.sender = socket.data.user ? `user:${socket.data.user.id}` : `address:${addressOf(socket)}`;
  // A private room per account, for notifications and profile changes.
  if (socket.data.user) socket.join(`user:${socket.data.user.id}`);
  const inTurn = (task) => turns(socket.id, task).catch((error) => console.error(error));

  socket.on("board:join", (payload, ack) => inTurn(() => joinBoard(socket, payload, ack)));
  socket.on("board:leave", () => inTurn(() => leaveBoard(socket)));

  // Replies { ok: true } with, when they apply, `cleaned` (elements as the board stored them, where that
  // isn't how they were sent) and `dropped` (ids of elements it refused); or { ok: false, reason }:
  // "noSession" (join the board first), "invalid", "tooLarge", "forbidden" or "rate".
  socket.on("board:op", (payload, ack) => {
    const reply = typeof ack === "function" ? ack : () => {};
    if (!limits.op()) return reply({ ok: false, reason: "rate" });
    const session = isOnBoard(socket, payload?.boardId) ? getSession(socket.data.boardId) : null;
    if (!session) return reply({ ok: false, reason: "noSession" });
    if (!canEdit(socket.data.role)) return reply(FORBIDDEN);
    let operation = payload.op;
    if (payload.group !== undefined) {
      // One piece of a change sent in several (see holdPiece): nothing is taken in until the last arrives.
      const piece = holdPiece(socket.data.heldGroup, payload.group, payload.op);
      if (!holdGroup(socket, piece.held)) return reply({ ok: false, reason: "rate" });
      if (piece.error) return reply(GROUP_REFUSED[piece.error] ?? GROUP_REFUSED.invalid);
      if (!piece.op) return reply({ ok: true });
      operation = piece.op;
    }
    takeOperation(socket, session, operation, reply, true);
  });

  // Uploading goes over the socket, not HTTP, so it is checked exactly like a
  // drawing change: guests with an edit link can add images, viewers can't.
  socket.on("board:image", async (payload, ack) => {
    const reply = typeof ack === "function" ? ack : () => {};
    const boardId = socket.data.boardId;
    if (!isOnBoard(socket, payload?.boardId)) return reply({ ok: false, error: "Open the board first." });
    if (!canEdit(socket.data.role)) return reply({ ok: false, readOnly: true });

    const buffer = payload?.data;
    if (!Buffer.isBuffer(buffer) || buffer.length === 0)
      return reply({ ok: false, error: "That file couldn't be read." });
    if (buffer.length > IMAGE_LIMITS.image)
      return reply({ ok: false, tooLarge: true, error: "That image is too big." });
    const mime = detectImageType(buffer);
    if (!mime) return reply({ ok: false, error: "Use a PNG, JPEG, WebP or GIF image." });

    try {
      const small = readSmallCopy(payload.small);
      const stored = await storeImage({
        boardId,
        buffer,
        mime,
        small,
        uploadedBy: socket.data.user?.id,
        address: addressOf(socket),
      });
      if (stored.missing) return reply({ ok: false, error: "This board doesn't exist any more." });
      if (stored.refused) return reply({ ok: false, error: stored.refused });
      if (stored.full)
        return reply({
          ok: false,
          full: stored.full,
          error: spaceMessage(stored.full, socket.data.role, stored.unverified),
        });
      reply({ ok: true, id: stored.id });
    } catch (error) {
      console.error(error);
      reply({ ok: false, error: "The image couldn't be saved. Try again." });
    }
  });

  socket.on("cursor", (payload) => {
    const boardId = socket.data.boardId;
    if (!boardId || !limits.cursor()) return;
    const x = Number(payload?.x);
    const y = Number(payload?.y);
    const visible = Number.isFinite(x) && Number.isFinite(y);
    socket.to(boardId).volatile.emit("cursor", visible ? { socketId: socket.id, x, y } : { socketId: socket.id });
  });

  // What part of the board someone is looking at, so others can follow along.
  socket.on("viewport", (payload) => {
    const boardId = socket.data.boardId;
    if (!boardId || !limits.viewport()) return;
    if (!["x", "y", "zoom", "width", "height"].every((key) => finite(payload?.[key]))) return;
    const zoom = Number(payload.zoom);
    if (zoom <= 0) return;
    // `source`: whose own view it is, when it's one taken from someone they follow (see useBoardSync).
    const source = typeof payload.source === "string" && payload.source.length <= 64 ? payload.source : socket.id;
    socket.to(boardId).volatile.emit("viewport", {
      boardId,
      socketId: socket.id,
      source,
      x: Number(payload.x),
      y: Number(payload.y),
      zoom,
      width: Number(payload.width),
      height: Number(payload.height),
    });
  });

  // Someone started following this person: ask them to send their view right away.
  socket.on("viewport:request", (payload) => {
    const boardId = socket.data.boardId;
    if (!limits.followRequest()) return;
    const target = io.sockets.sockets.get(String(payload?.socketId ?? ""));
    if (boardId && target?.data.boardId === boardId) target.emit("viewport:request", { boardId });
  });

  socket.on("guest:rename", async (payload) => {
    if (socket.data.user) return;
    socket.data.guest.name = cleanGuestName(payload?.name);
    if (socket.data.boardId) await broadcastPresence(socket.data.boardId);
  });

  // In turn too: a join still under way may put the socket in a room after it went.
  socket.on("disconnect", () => inTurn(() => leaveBoard(socket)));
}

async function joinBoard(socket, payload, ack) {
  const reply = typeof ack === "function" ? ack : () => {};
  const requestedId = String(payload?.boardId ?? "");
  try {
    const userId = socket.data.user?.id ?? null;
    const board = await findBoardForViewing(requestedId, userId);
    // The board as the database names it. The id in the request may spell it another way (upper case hex
    // finds it too), and a board must have one session and one room however it was asked for, or two
    // people on it would each save over the other, and events for it would miss those who spelled it differently.
    const boardId = board.id;
    // Joining the board it's already on is only a fresh copy of it. Otherwise the socket leaves
    // its board first, and the elements are read after that, so they include what it just did there.
    if (socket.data.boardId !== boardId) await leaveBoard(socket);
    const session = await enterBoard(socket, boardId, requestedId);
    await openOwner(session); // looked up now, so it's known by the time they draw
    socket.data.role = roleOf(board, userId);
    // Browsers still running an older version of the app merge changes by older rules (see prepareOperation).
    socket.data.legacy = payload?.sync !== SYNC_FORMAT;
    if (userId) recordOpen(userId, boardId);

    // With the stamps of what was removed lately, so a change to one of those
    // that's still on its way can't bring it back on this screen.
    reply({
      ok: true,
      board: serializeBoard(board, userId, session.elements),
      removed: removedStamps(session.tombstones),
    });
    await broadcastPresence(boardId);
  } catch (error) {
    if (!error.status) console.error(error);
    reply({
      ok: false,
      status: error.status ?? 500,
      error: error.status ? error.message : "This board couldn't be opened. Try again.",
    });
  }
}

// Puts the socket in the board's room and returns the board's open session. Getting the
// session and joining happen in the same turn, so it can't be closed in between.
// `requestedId` is how the socket named the board, which it may keep using in its messages.
async function enterBoard(socket, boardId, requestedId) {
  for (;;) {
    const session = await acquireSession(boardId);
    if (!holdSession(session)) continue; // it was closed, and saved, since: open it again
    socket.join(boardId);
    socket.data.boardId = boardId;
    socket.data.requestedId = requestedId;
    return session;
  }
}

async function leaveBoard(socket) {
  holdGroup(socket, null);
  const boardId = socket.data.boardId;
  if (!boardId) return;
  socket.leave(boardId);
  socket.data.boardId = null;
  await handleDeparture(boardId);
}

async function handleDeparture(boardId) {
  if (!boardId) return;
  const remaining = io.sockets.adapter.rooms.get(boardId)?.size ?? 0;
  if (remaining === 0) {
    await closeSession(boardId);
  } else {
    await broadcastPresence(boardId);
  }
}

async function broadcastPresence(boardId) {
  const sockets = await io.in(boardId).fetchSockets();
  // The board's id comes second, so browsers on an older app, which expect just the list, still read it.
  io.to(boardId).emit(
    "presence",
    sockets.map((s) => ({ socketId: s.id, ...personOf(s) })),
    { boardId },
  );
}

function socketsIn(room) {
  const ids = io?.sockets.adapter.rooms.get(room) ?? [];
  return [...ids].map((id) => io.sockets.sockets.get(id)).filter(Boolean);
}

// Hooks used by the REST API so open boards react to changes immediately.

// Each person gets the details their role allows: only members see email addresses.
export function notifyMetaChanged(board) {
  for (const socket of socketsIn(board.id)) {
    socket.emit("board:meta", serializeMeta(board, { redact: !isMemberRole(socket.data.role) }));
  }
}

/**
 * Re-checks everyone who has the board open after its access changed (an invite,
 * a removal, or the link setting): drops people who lost access, upgrades or
 * downgrades the rest, then sends fresh board details.
 */
export async function syncAccess(board) {
  if (!io) return;
  let dropped = false;
  for (const socket of socketsIn(board.id)) {
    const role = roleOf(board, socket.data.user?.id ?? null);
    if (!role) {
      socket.emit("board:revoked", { boardId: board.id });
      socket.leave(board.id);
      socket.data.boardId = null;
      holdGroup(socket, null);
      dropped = true;
    } else if (role !== socket.data.role) {
      socket.data.role = role;
      socket.emit("board:role", { boardId: board.id, role });
    }
  }
  if (dropped) await handleDeparture(board.id);
  notifyMetaChanged(board);
}

/**
 * Puts an earlier version's elements back on a board, for everyone who has it
 * open. Resolves with the board's elements as restored.
 */
export async function replaceElements(boardId, snapshot, actor) {
  // Always through the open board, so someone opening it at this moment can't put the old one back.
  const session = await acquireSession(boardId);
  const elements = resetSession(session, snapshot);
  io?.to(boardId).emit("board:reset", {
    boardId,
    elements,
    removed: removedStamps(session.tombstones),
    by: actor?.name ?? null,
  });
  // With nobody on it, the board goes again, saved. (Someone opening it meanwhile keeps it open.)
  if (!io?.sockets.adapter.rooms.has(boardId)) await closeSession(boardId);
  return elements;
}

/** Comments are only shown to signed-in people. */
export function emitToSignedIn(boardId, event, payload) {
  for (const socket of socketsIn(boardId)) {
    if (socket.data.user) socket.emit(event, payload);
  }
}

export function notifyUser(userId, notification) {
  io?.to(`user:${userId}`).emit("notification", notification);
}

/** Closes every connection of an account whose logins were all revoked (a password change, say). */
export function disconnectUser(userId) {
  for (const socket of socketsIn(`user:${userId}`)) socket.disconnect(true);
}

/** Someone changed their name or color: update their open connections and boards. */
export async function refreshUser(user) {
  const boards = new Set();
  for (const socket of socketsIn(`user:${user.id}`)) {
    socket.data.user = user.toPublic();
    if (socket.data.boardId) boards.add(socket.data.boardId);
  }
  await Promise.all([...boards].map(broadcastPresence));
}

/**
 * Sends everyone off a board that was deleted. A board moved to the trash keeps
 * its latest changes so it can be restored as it was.
 */
export async function closeBoard(boardId, { keepChanges = false } = {}) {
  if (!io) return;
  io.to(boardId).emit("board:deleted", { boardId });
  const sockets = await io.in(boardId).fetchSockets();
  for (const remote of sockets) {
    const socket = io.sockets.sockets.get(remote.id);
    if (socket) {
      socket.data.boardId = null;
      holdGroup(socket, null);
    }
  }
  io.in(boardId).socketsLeave(boardId);
  if (keepChanges) await closeSession(boardId);
  else discardSession(boardId);
}
