import { createHash } from "node:crypto";
import type { Server as HttpServer } from "node:http";
import type { NotificationItem, PublicUser, Thread } from "@inkboard/shared/api";
import { cleanElement, cutText } from "@inkboard/shared/element-rules";
import type {
  ClientToServerEvents,
  JoinPayload,
  JoinReply,
  OpMessage,
  OpRefusal,
  OpReply,
  Participant,
  Classroom,
  PieceGroup,
  PrivateMode,
  ServerToClientEvents,
  SuggestionRefusal,
  ThreadRemoval,
} from "@inkboard/shared/socket";
import type { Suggestion } from "@inkboard/shared/suggestions";
import { insideZone } from "@inkboard/shared/zones";
import type { Element, FrameElement } from "@inkboard/shared/types";
import { Server } from "socket.io";
import type { Socket } from "socket.io";
import { env } from "../config/env.ts";
import { keyedQueue } from "../lib/keyed-queue.ts";
import { userForToken } from "../lib/tokens.ts";
import {
  canEdit,
  currentElements,
  findBoardForViewing,
  isMemberRole,
  LinkLockedError,
  linkLock,
  populateMembers,
  recordOpen,
  rememberUnlock,
  roleOf,
  roomLeft,
  serializeBoard,
  serializeMeta,
} from "../services/boards.ts";
import type { PopulatedMembers, Role } from "../services/boards.ts";
import { replaySteps } from "../services/replay.ts";
import { Board } from "../models/board.model.ts";
import { GuestKey } from "../models/guest-key.model.ts";
import { detectImageType, IMAGE_LIMITS, storeImage } from "../services/images.ts";
import { notifySuggestion, warnOwner } from "../services/notifications.ts";
import { recordVersion } from "../services/versions.ts";
import type { ImageLimit } from "../services/images.ts";
import { effectOf, planOperation } from "@inkboard/shared/board-merge";
import { classroomFor, nextClassroom, outsideZone, zoneOf } from "./classroom.ts";
import { countdownAt, nextCountdown } from "./countdown.ts";
import { emptyLinkWatch, LINK_VISITORS_WARNING, MASS_REMOVAL, noteRemovals, noteVisitor } from "./link-watch.ts";
import type { LinkWatch } from "./link-watch.ts";
import {
  holdPiece,
  isOversized,
  MAX_GROUP_BYTES,
  mergedTyping,
  prepareOperation,
  sanitizeOperation,
  SYNC_FORMAT,
} from "./operations.ts";
import type { ExpiredGroup, GroupError, HeldGroup, RawOperation } from "./operations.ts";
import { createLimiter, LIMITS } from "./rate-limit.ts";
import type { Limiter } from "./rate-limit.ts";
import { nextVoting, votingFor } from "./voting.ts";
import {
  acquireSession,
  admit,
  closeSession,
  discardSession,
  flushAllSessions,
  getSession,
  holdSession,
  removedStamps,
  markFacilitationDirty,
  markSuggestionsDirty,
  resetSession,
  updateSession,
} from "./sessions.ts";
import type { Session } from "./sessions.ts";
import {
  putSuggestions,
  resolveSuggestions,
  sameAuthor,
  settleSuggestions,
  suggestionList,
  withdrawSuggestions,
} from "./suggestions.ts";

// Payloads are unchecked, so handlers get them as Untrusted: every field unknown, the payload possibly missing.
type Untrusted<Payload> = { [Field in keyof Payload]?: unknown } | null | undefined;

// A shared-map handler with an Untrusted payload; the ack may be missing, so handlers check for it.
type UntrustedHandler<Handler> = Handler extends () => void
  ? Handler
  : Handler extends (payload: infer Payload) => void
    ? (payload: Untrusted<Payload>) => void
    : Handler extends (payload: infer Payload, ack: infer Ack) => void
      ? (payload: Untrusted<Payload>, ack?: Ack) => void
      : never;

export type UntrustedClientEvents = {
  [Event in keyof ClientToServerEvents]: UntrustedHandler<ClientToServerEvents[Event]>;
};

export type InterServerEvents = Record<never, never>;

export interface SocketData {
  user: PublicUser | null;
  guest?: { id: string; name: string };
  // whom the memory held for unfinished groups counts against (see holdGroup)
  sender: string;
  // the database's id for the board, and the spelling the socket asked with (see isOnBoard)
  boardId?: string | null;
  requestedId?: string;
  // null until the first join sets it, which means no access
  role: Role | null;
  // the board's own role, before private mode turns editors into suggesters (see effectiveRole)
  boardRole?: Role | null;
  // the link-password pass the socket joined with (see link-pass.ts)
  pass?: string;
  // the browser merges by the older rules (see prepareOperation)
  legacy?: boolean;
  presenting?: boolean;
  // an embed on another site only views, and isn't shown to the others
  embed?: boolean;
  // unfinished piece-group and its idle timer (see holdGroup)
  heldGroup?: HeldGroup | ExpiredGroup | null;
  heldTimer?: ReturnType<typeof setTimeout> | null;
}

export type RealtimeServer = Server<UntrustedClientEvents, ServerToClientEvents, InterServerEvents, SocketData>;
export type RealtimeSocket = Socket<UntrustedClientEvents, ServerToClientEvents, InterServerEvents, SocketData>;

// the database and services throw HttpErrors, which carry a status
type Failure = Error & { status?: number };

// the REST hooks use `io?.` because they can run before attachRealtime
let io: RealtimeServer;

export function attachRealtime(httpServer: HttpServer) {
  io = new Server(httpServer, {
    cors: { origin: env.clientOrigins },
    // room for an image (IMAGE_LIMITS.image), its small copy, and the message around them
    maxHttpBufferSize: 3e6,
    // big joins compress well; small messages (cursors, most changes) cost more to compress than they save
    perMessageDeflate: { threshold: 4096, zlibDeflateOptions: { level: 1 } },
  });
  io.use(authenticate);
  io.on("connection", handleConnection);
  return io;
}

export { flushAllSessions };

// disconnecting saves what was still being written, hence the second flush
export async function closeRealtime() {
  await flushAllSessions();
  await io?.close();
  await flushAllSessions();
}

// older browsers (open during an update) look for `tooLarge` and `readOnly`
const TOO_LARGE: OpRefusal = { ok: false, reason: "tooLarge", tooLarge: true };
const FORBIDDEN: OpRefusal = { ok: false, reason: "forbidden", readOnly: true };
// "expired": the server dropped the rest of the group, so the sender resends the whole change (see holdPiece)
const GROUP_REFUSED: Record<GroupError, OpRefusal> = {
  invalid: { ok: false, reason: "invalid" },
  tooLarge: TOO_LARGE,
  expired: { ok: false, reason: "expired" },
};

// Held pieces take memory until the group completes: idle groups are dropped, and bytes are capped per sender (an
// account, or a guest's address: guests can open many connections) and overall. Over a cap the sender gets "rate".
const GROUP_IDLE_MS = 60_000;
const MAX_HELD_BYTES_PER_SENDER = 2 * MAX_GROUP_BYTES;
const MAX_HELD_BYTES = 4 * MAX_GROUP_BYTES;
const held = { total: 0, bySender: new Map<string, number>() };

// Returns false, holding nothing, when keeping `group` would pass a cap.
function holdGroup(socket: RealtimeSocket, group: HeldGroup | ExpiredGroup | null) {
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
  clearTimeout(socket.data.heldTimer!); // clearTimeout accepts null/undefined, which Node's types omit
  socket.data.heldTimer = kept?.pieces ? setTimeout(() => expireGroup(socket), GROUP_IDLE_MS).unref() : null;
  return fits;
}

// the id is kept, so a late piece is told to resend rather than "invalid"
function expireGroup(socket: RealtimeSocket) {
  const { id } = socket.data.heldGroup ?? {};
  holdGroup(socket, id ? { id, expired: true } : null);
}

// A change growing a board past its owner's remaining space (BOARD_LIMITS) is refused. Summing an owner's space reads
// all their boards, versions and templates, so it's done at most this often per owner, and growth since is subtracted.
const ROOM_CHECK_MS = 30_000;
// before refusing for space, a figure older than this is looked up again (the owner may have made room)
const ROOM_REFRESH_MS = 3_000;
// after a failed lookup, the next change retries once this long has passed
const ROOM_RETRY_MS = 2_000;
// `tooLarge` is for older browsers, which don't know "ownerFull" and would resend forever: they undo the change
const OWNER_FULL: OpRefusal = { ok: false, reason: "ownerFull", tooLarge: true };

// owner id -> last looked-up room (at `at`), the lookup under way, and the owner's open boards, which tell whether
// anything has kept the figure current since
const owners = new Map<string, OwnerEntry>();

interface OwnerEntry {
  room: number | undefined;
  at: number;
  pending: Promise<void> | null;
  boards: Map<string, Session>;
}

function ownerEntry(owner: string) {
  let entry = owners.get(owner);
  if (!entry) {
    // drop owners with nothing open, so the map doesn't grow with every owner ever seen
    if (owners.size > 1000) {
      for (const [id, other] of owners) if (!other.pending && Date.now() - other.at >= ROOM_CHECK_MS) owners.delete(id);
    }
    entry = { room: undefined, at: 0, pending: null, boards: new Map() };
    owners.set(owner, entry);
  }
  return entry;
}

// never rejects
function lookUpRoom(owner: string) {
  const entry = ownerEntry(owner);
  entry.pending ??= roomLeft(owner)
    .then(
      (left) => {
        entry.room = left;
        entry.at = Date.now();
      },
      (error: Error) => {
        // keep the old figure and retry on the next change
        entry.at = Date.now() - ROOM_CHECK_MS + ROOM_RETRY_MS;
        console.error(`Could not add up the space used by ${owner}: ${error.message}`);
      },
    )
    .finally(() => {
      entry.pending = null;
    });
  return entry.pending;
}

// Waits for the lookup unless a recent figure exists, so the first change has one. A figure kept while none of the
// owner's boards were open is dropped: nothing kept it current.
async function openOwner(session: Session) {
  if (!session.owner) return;
  const entry = ownerEntry(session.owner);
  for (const [id, open] of entry.boards) if (getSession(id) !== open) entry.boards.delete(id);
  if (entry.boards.size === 0) entry.at = 0;
  entry.boards.set(session.boardId, session);
  if (Date.now() - entry.at >= ROOM_CHECK_MS) await lookUpRoom(session.owner);
}

// Infinity when unknown (no owner, or no lookup has worked yet): failing open for a change or two beats refusing
// everything while the database is slow.
function ownerRoom(session: Session) {
  if (!session.owner) return Infinity;
  const entry = ownerEntry(session.owner);
  if (!entry.pending && Date.now() - entry.at >= ROOM_CHECK_MS) lookUpRoom(session.owner);
  return entry.room ?? Infinity;
}

export const heldGroupBytes = () => held.total;

// join and leave run one at a time per connection, so a quick join, leave, join can't leave a socket in two rooms
const turns = keyedQueue();

const GUEST_ID = /^g_[a-z0-9]{6,32}$/i;

export function cleanGuestName(value: unknown) {
  const name = cutText(
    String(value ?? "")
      .trim()
      .replace(/\s+/g, " "),
    40,
  );
  return name || "Guest";
}

const GUEST_KEY = /^[a-z0-9_-]{16,128}$/i;

// Ids are shown to everyone, so without the key an id was first used with, taking someone's id would let a person act
// as them (in classroom mode, draw in their frame). No valid key (or an old browser) gets an id for this connection.
async function guestIdentity(socket: RealtimeSocket, id: unknown, key: unknown): Promise<string> {
  const fallback = `g_${socket.id.replace(/[^a-z0-9]/gi, "")}`;
  // strings first: a pattern coerces its input, so ["g_abcdef"] would pass
  if (typeof id !== "string" || !GUEST_ID.test(id) || typeof key !== "string" || !GUEST_KEY.test(key)) return fallback;
  const hash = createHash("sha256").update(key).digest("base64url");
  // the first key an id comes with is the one it keeps
  const kept = await GuestKey.findOneAndUpdate(
    { _id: id },
    { $setOnInsert: { hash }, $set: { seenAt: new Date() } },
    { upsert: true, new: true },
  ).lean();
  return kept.hash === hash ? id : fallback;
}

// No token is allowed: guests open boards whose link is shared, with a name, a random id and a key proving it's theirs.
async function authenticate(socket: RealtimeSocket, next: (error?: Error) => void) {
  const { token, guest }: { token?: unknown; guest?: { id?: unknown; name?: unknown; key?: unknown } } =
    socket.handshake.auth ?? {};
  if (!token) {
    socket.data.user = null;
    try {
      socket.data.guest = { id: await guestIdentity(socket, guest?.id, guest?.key), name: cleanGuestName(guest?.name) };
    } catch {
      return next(new Error("Couldn't connect. Try again."));
    }
    return next();
  }
  try {
    // anything that isn't a token makes userForToken throw
    const { user } = await userForToken(token as string);
    socket.data.user = user.toPublic();
    next();
  } catch {
    next(new Error("unauthorized"));
  }
}

function personOf(socket: Pick<RealtimeSocket, "data">): Participant {
  const { user, guest } = socket.data;
  if (user) {
    return { userId: user.id, name: user.name, color: user.color, avatarUrl: user.avatarUrl, guest: false };
  }
  return { userId: guest!.id, name: guest!.name, color: null, avatarUrl: null, guest: true };
}

const finite = (value: unknown) => Number.isFinite(Number(value));

// an embed only views, even on an edit link
const roleFor = (socket: Pick<RealtimeSocket, "data">, role: Role | null): Role | null =>
  role && socket.data.embed ? "viewer" : role;

// Private mode: everyone who could edit, bar whoever turned it on, suggests instead, and their suggestions go only to
// themselves until it's turned off.
function effectiveRole(socket: Pick<RealtimeSocket, "data">, session: Session | undefined): Role | null {
  const role = socket.data.boardRole ?? null;
  const by = session?.privateMode?.by;
  return by && canEdit(role) && personOf(socket).userId !== by ? "suggester" : role;
}

// Classroom mode (see classroom.ts): a student is an editor who isn't a member, limited to the frame they claimed.
const isStudent = (role: Role | null | undefined) => canEdit(role ?? null) && !isMemberRole(role ?? null);
const frameIn = (session: Session) => (id: string) => {
  const element = session.index.get(id);
  return element?.type === "frame" ? element : undefined;
};
const restrictedIn = (session: Session, role: Role | null | undefined) =>
  Boolean(session.classroom?.on) && isStudent(role);
const classroomOf = (session: Session, socket: Pick<RealtimeSocket, "data">): Classroom | null =>
  classroomFor(session.classroom, personOf(socket).userId, restrictedIn(session, socket.data.boardRole), (id) =>
    Boolean(frameIn(session)(id)),
  );
const zoneIn = (session: Session, userId: string, role: Role | null | undefined) =>
  zoneOf(session.classroom, userId, restrictedIn(session, role), frameIn(session));

// a suggestion as sent, unchecked (see readDraft in suggestions.ts)
type RawDraft = { kind?: unknown; target?: unknown; element?: { id?: unknown } } | null | undefined;

function draftInside(draft: RawDraft, zone: FrameElement | null, session: Session) {
  if (!zone) return false;
  const current = (id: unknown) => (typeof id === "string" ? session.index.get(id) : undefined);
  if (draft?.kind === "remove") {
    const target = current(draft.target);
    return Boolean(target && insideZone(target, zone));
  }
  const element = cleanElement(draft?.element);
  if (!element || !insideZone(element, zone)) return false;
  const before = current(element.id);
  return draft?.kind === "add" ? !before : Boolean(before && insideZone(before, zone));
}

function announceClassroom(session: Session) {
  markFacilitationDirty(session);
  for (const socket of socketsIn(session.boardId)) {
    socket.emit("classroom", { boardId: session.boardId, classroom: classroomOf(session, socket) });
  }
}

const privateModeFor = (session: Session, socket: Pick<RealtimeSocket, "data">): PrivateMode | null =>
  session.privateMode && { by: session.privateMode.name, canEnd: isMemberRole(socket.data.boardRole ?? null) };

// in private mode only its author is shown a suggestion
const showsSuggestion = (session: Session, socket: Pick<RealtimeSocket, "data">) => (suggestion: Suggestion) =>
  !session.privateMode || sameAuthor(suggestion.author, personOf(socket));

// optional (thumbnails fall back to the image itself), so a bad one is dropped
function readSmallCopy(data: unknown) {
  if (!Buffer.isBuffer(data) || data.length > IMAGE_LIMITS.small) return null;
  const mime = detectImageType(data);
  return mime ? { buffer: data, mime } : null;
}

// as far as the proxies in front of this server say (see TRUST_PROXY)
function addressOf(socket: RealtimeSocket) {
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

function spaceMessage(limit: ImageLimit, role: Role | null, unverified: boolean | undefined) {
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

// the board id in a message may be the database's or the spelling the socket asked with (upper case, say)
function isOnBoard(socket: RealtimeSocket, claimed: unknown) {
  const { boardId, requestedId } = socket.data;
  return Boolean(boardId) && (claimed === boardId || claimed === requestedId);
}

// Where a change comes from: a browser on the board, or the public API (see applyOperation).
interface Sender {
  boardId: string;
  legacy?: boolean | undefined;
  // classroom mode: the student's frame (null: none); `whole` refuses the whole change if any of it is outside
  zone?: FrameElement | null | undefined;
  whole?: boolean;
  broadcast: (message: OpMessage) => void;
  present: () => boolean;
  // told how many elements were removed, and the board before, for senders who came through the link
  removed?: (count: number, before: Element[]) => void;
}

const linkWatches = new WeakMap<Session, LinkWatch>();
function watchOf(session: Session) {
  let watch = linkWatches.get(session);
  if (!watch) linkWatches.set(session, (watch = emptyLinkWatch()));
  return watch;
}

const VISITORS_WARNING = `${LINK_VISITORS_WARNING} people who weren't invited have opened it with its edit link. If you didn't share the link that widely, restrict it in Share.`;
const REMOVAL_LABEL = "Before the edit-link removals"; // short enough to read whole in version history

// Much removal by people on the link (see noteRemovals) saves the earlier board in version history and warns the owner.
function watchRemovals(session: Session, count: number, before: Element[]) {
  const earlier = noteRemovals(watchOf(session), count, before);
  if (!earlier) return;
  const what = `${MASS_REMOVAL} or more elements were removed by people using its edit link.`;
  recordVersion(session.boardId, earlier, { kind: "auto", label: REMOVAL_LABEL })
    .then((version) =>
      warnOwner(
        session.boardId,
        "removals",
        version
          ? `${what} A copy from before is in version history.`
          : `${what} Version history had no room for a copy from before.`,
      ),
    )
    .catch((error: Error) => console.error(`Could not keep board ${session.boardId} from before: ${error.message}`));
}

function socketSender(socket: RealtimeSocket): Sender {
  const boardId = socket.data.boardId!;
  return {
    boardId,
    legacy: socket.data.legacy,
    broadcast: (message) => socket.to(boardId).emit("board:op", message),
    present: () => socket.data.boardId === boardId,
    zone: (() => {
      const session = getSession(boardId);
      return session && zoneIn(session, personOf(socket).userId, socket.data.boardRole);
    })(),
    ...(socket.data.role === "contributor" && {
      removed: (count: number, before: Element[]) => {
        const session = getSession(boardId);
        if (session && !session.classroom?.on) watchRemovals(session, count, before);
      },
    }),
  };
}

// `refresh`: a refusal for lack of space may first be checked against a newer figure; that lookup is the only wait,
// after which the change is planned again from the board as it then is.
function takeOperation(
  sender: Sender,
  session: Session,
  operation: RawOperation | null | undefined,
  reply: (reply: OpReply) => void,
  refresh: boolean,
) {
  const { boardId } = sender;
  if (isOversized(operation)) return reply(TOO_LARGE);
  const sanitized = sanitizeOperation(operation);
  if (!sanitized) return reply({ ok: false, reason: "invalid" });
  let op = prepareOperation(session.elements, sanitized, session.tombstones, {
    legacy: sender.legacy,
    index: session.index,
  });
  let plan = planOperation(session.elements, op, session.tombstones, { index: session.index, remember: false });
  // classroom mode: what a student would change outside their frame is left out, and they're told
  const outside =
    sender.zone === undefined
      ? null
      : outsideZone(plan, (id) => session.index.get(id) ?? session.tombstones.get(id)?.element, sender.zone);
  if (outside && outside.upsert.length + outside.remove.length > 0) {
    if (sender.whole) return reply({ ok: false, reason: "outside" });
    const skipped = new Set([...outside.upsert, ...outside.remove]);
    op = {
      ...op,
      upsert: op.upsert.filter((element) => !skipped.has(element.id)),
      remove: op.remove.filter((removal) => !skipped.has(removal.id)),
    };
    plan = planOperation(session.elements, op, session.tombstones, { index: session.index, remember: false });
  }
  // edits that newer ones already replaced are left out; the rest go out as the server now has them, merged
  const effect = effectOf(plan);
  const before = session.bytes;
  const room = ownerRoom(session);
  const refused = admit(
    session,
    { upsert: [...plan.shown.values()], remove: effect.remove },
    [...plan.buried.values()],
    room,
  );
  // refused for the owner's room only when it's a figure, which a board without an owner never has
  if (refused === "owner" && refresh && Date.now() - ownerEntry(session.owner!).at > ROOM_REFRESH_MS) {
    lookUpRoom(session.owner!).then(() => {
      // nothing is taken for a socket that left, or a board that closed, meanwhile
      if (sender.present() && getSession(boardId) === session) {
        takeOperation(sender, session, operation, reply, false);
      } else reply({ ok: false, reason: "noSession" });
    });
    return;
  }
  if (refused) return reply(refused === "owner" ? OWNER_FULL : TOO_LARGE);
  // a finite room is the figure ownerRoom read from the owner's entry
  if (Number.isFinite(room)) ownerEntry(session.owner!).room! -= Math.max(0, session.bytes - before);

  const board = session.elements; // as it was before this change
  const dropped = new Set(updateSession(session, plan));
  if (effect.remove.length > 0) sender.removed?.(effect.remove.length, board);
  if (dropped.size > 0) effect.upsert = effect.upsert.filter((element) => !dropped.has(element.id));
  if (effect.upsert.length > 0 || effect.remove.length > 0) {
    sender.broadcast({ boardId, op: effect });
    // a suggested element now on the board was accepted; suggestions about removed elements go too
    const touched = [...effect.upsert.map((element) => element.id), ...effect.remove.map((removal) => removal.id)];
    announceSettled(session, settleSuggestions(session.suggestions, session, touched));
  }

  // the sender drew these on its own screen, so it's told where the board differs, its typing merged with others'
  const typed = mergedTyping(op.upsert, (id) => session.index.get(id));
  const merged = new Set(typed.map((element) => element.id));
  const cleaned = [...sanitized.changed.filter((element) => !merged.has(element.id)), ...typed];
  for (const id of [...sanitized.refused, ...(outside?.upsert ?? [])]) {
    const stored = session.index.get(id);
    if (stored) cleaned.push(stored);
    else dropped.add(id);
  }
  // what a student removed outside their frame is still on the board
  const restored = (outside?.remove ?? []).flatMap((id) => session.index.get(id) ?? []);
  reply({
    ok: true,
    ...(cleaned.length > 0 ? { cleaned } : {}),
    ...(dropped.size > 0 ? { dropped: [...dropped] } : {}),
    ...(restored.length > 0 ? { restored } : {}),
    ...(outside && outside.upsert.length + outside.remove.length > 0 ? { outside: true as const } : {}),
  });
}

// Takes a change from outside a browser (the public API): opens the board as a join does, and saves and releases it if
// nobody else has it open. Resolves to the reply a browser would get, and the session.
export async function applyOperation(
  boardId: string,
  operation: RawOperation,
  writer: { userId: string; role: Role | null },
) {
  let session: Session;
  do session = await acquireSession(boardId);
  while (!holdSession(session)); // closed, and saved, since: open it again
  const sender: Sender = {
    boardId,
    broadcast: (message) => io.to(boardId).emit("board:op", message),
    present: () => true,
    // classroom mode: a student's change is taken whole, inside their frame, or not at all
    zone: zoneIn(session, writer.userId, writer.role),
    whole: true,
  };
  const reply = await new Promise<OpReply>((resolve) => takeOperation(sender, session, operation, resolve, true));
  if (!io.sockets.adapter.rooms.get(boardId)?.size) await closeSession(boardId);
  return { reply, session };
}

function announceSettled(session: Session, { accepted, gone }: { accepted: string[]; gone: string[] }) {
  const { boardId } = session;
  if (accepted.length > 0) io.to(boardId).emit("suggestion:delete", { boardId, ids: accepted, outcome: "accepted" });
  if (gone.length > 0) io.to(boardId).emit("suggestion:delete", { boardId, ids: gone, outcome: "gone" });
  if (accepted.length + gone.length > 0) markSuggestionsDirty(session);
}

// when an open board's owner was last notified of suggestions
const suggestionsNoted = new WeakMap<Session, number>();
const SUGGESTION_NOTICE_MS = 60_000;

const SUGGESTION_FORBIDDEN = { ok: false, reason: "forbidden" } as const;
const SUGGESTION_INVALID = { ok: false, reason: "invalid" } as const;

function handleConnection(socket: RealtimeSocket) {
  const limits: Record<string, Limiter> = Object.fromEntries(
    Object.entries(LIMITS).map(([name, limit]) => [name, createLimiter(limit)]),
  );
  socket.data.sender = socket.data.user ? `user:${socket.data.user.id}` : `address:${addressOf(socket)}`;
  // a private room per account, for notifications and profile changes
  if (socket.data.user) socket.join(`user:${socket.data.user.id}`);
  const inTurn = (task: () => Promise<void>) => turns(socket.id, task).catch((error: unknown) => console.error(error));

  socket.on("board:join", (payload, ack) => inTurn(() => joinBoard(socket, payload, ack)));
  socket.on("board:leave", () => inTurn(() => leaveBoard(socket)));

  socket.on("board:op", (payload, ack) => {
    const reply = typeof ack === "function" ? ack : () => {};
    if (!limits.op()) return reply({ ok: false, reason: "rate" });
    const session = isOnBoard(socket, payload?.boardId) ? getSession(socket.data.boardId!) : null;
    if (!session) return reply({ ok: false, reason: "noSession" });
    if (!canEdit(socket.data.role)) return reply(FORBIDDEN);
    // the op is unchecked: takeOperation sanitizes it
    let operation = payload!.op as RawOperation | null | undefined;
    if (payload!.group !== undefined) {
      // one piece of a change sent in several: nothing is taken in until the last arrives (holdPiece checks the label)
      const piece = holdPiece(
        socket.data.heldGroup,
        payload!.group as PieceGroup | null | undefined,
        payload!.op as RawOperation | null | undefined,
      );
      if (!holdGroup(socket, piece.held)) return reply({ ok: false, reason: "rate" });
      if (piece.error) return reply(GROUP_REFUSED[piece.error] ?? GROUP_REFUSED.invalid);
      if (!piece.op) return reply({ ok: true });
      operation = piece.op;
    }
    takeOperation(socketSender(socket), session, operation, reply, true);
  });

  // over the socket, not HTTP, so it's checked like a drawing change: edit-link guests can add images, viewers can't
  socket.on("board:image", async (payload, ack) => {
    const reply = typeof ack === "function" ? ack : () => {};
    const boardId = socket.data.boardId as string;
    if (!isOnBoard(socket, payload?.boardId)) return reply({ ok: false, error: "Open the board first." });
    if (!canEdit(socket.data.role)) return reply({ ok: false, readOnly: true });
    // classroom mode: students add no pictures (docs/classroom-mode.md)
    const open = getSession(boardId);
    if (open && zoneIn(open, personOf(socket).userId, socket.data.boardRole) !== undefined) {
      return reply({ ok: false, error: "In classroom mode, pictures can't be added." });
    }

    const buffer = payload?.data;
    if (!Buffer.isBuffer(buffer) || buffer.length === 0)
      return reply({ ok: false, error: "That file couldn't be read." });
    if (buffer.length > IMAGE_LIMITS.image)
      return reply({ ok: false, tooLarge: true, error: "That image is too big." });
    const mime = detectImageType(buffer);
    if (!mime) return reply({ ok: false, error: "Use a PNG, JPEG, WebP or GIF image." });

    try {
      const small = readSmallCopy(payload!.small);
      const stored: {
        id?: string;
        full?: ImageLimit;
        unverified?: true;
        missing?: true;
        refused?: string;
      } = await storeImage({
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
      reply({ ok: true, id: stored.id! });
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
    const laser = payload?.laser === true ? { laser: true as const } : {};
    socket
      .to(boardId)
      .volatile.emit("cursor", visible ? { socketId: socket.id, x, y, ...laser } : { socketId: socket.id });
  });

  socket.on("viewport", (payload) => {
    const boardId = socket.data.boardId;
    if (!boardId || !limits.viewport()) return;
    if (!(["x", "y", "zoom", "width", "height"] as const).every((key) => finite(payload?.[key]))) return;
    const zoom = Number(payload!.zoom);
    if (zoom <= 0) return;
    // `source`: whose own view this is, when taken from someone they follow (see useBoardSync)
    const source = typeof payload!.source === "string" && payload!.source.length <= 64 ? payload!.source : socket.id;
    socket.to(boardId).volatile.emit("viewport", {
      boardId,
      socketId: socket.id,
      source,
      x: Number(payload!.x),
      y: Number(payload!.y),
      zoom,
      width: Number(payload!.width),
      height: Number(payload!.height),
    });
  });

  // someone started following this person: they send their view right away
  socket.on("viewport:request", (payload) => {
    const boardId = socket.data.boardId;
    if (!limits.followRequest()) return;
    const target = io.sockets.sockets.get(String(payload?.socketId ?? ""));
    if (boardId && target?.data.boardId === boardId) target.emit("viewport:request", { boardId });
  });

  // members, and link visitors when the owner lets them watch (it shows what was drawn and later removed)
  socket.on("board:replay", async (payload, ack) => {
    const reply = typeof ack === "function" ? ack : () => {};
    const boardId = socket.data.boardId;
    if (!boardId || !isOnBoard(socket, payload?.boardId)) return reply({ ok: false, error: "Open the board first." });
    if (!limits.replay()) return reply({ ok: false, error: "Wait a few seconds and try again." });
    try {
      if (!isMemberRole(socket.data.role)) {
        const board = await Board.findById(boardId).select("linkReplay").lean();
        if (!board?.linkReplay) return reply({ ok: false, error: "Only the board's members can watch its replay." });
      }
      const [steps, elements] = await Promise.all([replaySteps(boardId), currentElements(boardId)]);
      reply({ ok: true, steps, elements });
    } catch (error) {
      console.error(error);
      reply({ ok: false, error: "The replay couldn't be loaded. Try again." });
    }
  });

  // Dot voting (see voting.ts): anyone votes, editors run the round, and each person sees only their own votes while it's open.
  socket.on("vote", (payload) => {
    const boardId = socket.data.boardId;
    if (!boardId || socket.data.embed || !limits.vote()) return;
    const session = getSession(boardId);
    if (!session) return;
    const next = nextVoting(session.voting, payload, {
      id: personOf(socket).userId,
      canRun: canEdit(socket.data.role),
      typeOf: (id) => session.index.get(id)?.type,
    });
    if (next === undefined) return;
    session.voting = next;
    markFacilitationDirty(session);
    for (const other of socketsIn(boardId)) {
      other.emit("voting", { boardId, voting: votingFor(next, personOf(other).userId) });
    }
  });

  // the others follow the presenter's view (see useFollow)
  socket.on("present", async (payload) => {
    const boardId = socket.data.boardId;
    if (!boardId || !limits.present()) return;
    socket.data.presenting = payload?.on === true;
    await broadcastPresence(boardId);
  });

  // the board's timer (see countdown.ts): editors set it, everyone is told
  socket.on("countdown", (payload) => {
    const boardId = socket.data.boardId;
    if (!boardId || !limits.countdown() || !canEdit(socket.data.role)) return;
    const session = getSession(boardId);
    if (!session) return;
    const now = Date.now();
    const next = nextCountdown(session.countdown, payload, now);
    if (next === undefined) return;
    session.countdown = next;
    markFacilitationDirty(session);
    io.to(boardId).emit("countdown", { boardId, countdown: countdownAt(next, now) });
  });

  // Private mode: a member (owner or invited editor, not an edit-link guest) turns it on or off. On: the other editors
  // become suggesters and rejoin as such. Off: they're editors again and everyone sees every suggestion.
  socket.on("private", (payload) => {
    const boardId = socket.data.boardId;
    if (!boardId || !limits.privateMode() || !isMemberRole(socket.data.boardRole ?? null)) return;
    const session = getSession(boardId);
    const on = payload?.on === true;
    if (!session || on === Boolean(session.privateMode)) return;
    const { userId, name } = personOf(socket);
    session.privateMode = on ? { by: userId, name } : null;
    markFacilitationDirty(session);
    for (const other of socketsIn(boardId)) {
      const role = effectiveRole(other, session);
      if (role !== other.data.role) {
        other.data.role = role;
        other.emit("board:role", { boardId, role: role! });
      }
      other.emit("private", { boardId, privateMode: privateModeFor(session, other) });
    }
    if (!on) io.to(boardId).emit("suggestion:upsert", { boardId, suggestions: suggestionList(session.suggestions) });
  });

  // Classroom mode (see classroom.ts): members start and stop it and free frames; a student claims an empty frame, and
  // a frame two students reach for at once goes to the first (the reply says whether it was done).
  socket.on("classroom", (payload, ack) => {
    const reply = typeof ack === "function" ? ack : () => {};
    const boardId = socket.data.boardId;
    const session = boardId && !socket.data.embed && limits.classroom() ? getSession(boardId) : undefined;
    if (!session) return reply({ ok: false });
    const { userId, name } = personOf(socket);
    const next = nextClassroom(session.classroom, payload, {
      id: userId,
      name,
      member: isMemberRole(socket.data.boardRole ?? null),
      student: isStudent(socket.data.boardRole),
      isFrame: (id) => Boolean(frameIn(session)(id)),
    });
    if (next === undefined) return reply({ ok: false });
    session.classroom = next;
    announceClassroom(session);
    reply({ ok: true });
  });

  // Suggestions (see suggestions.ts, docs/suggest-mode.md): only a suggester makes them, anyone withdraws their own, a
  // member resolves them. Each counts against the same limit as a board change. Returns the session, or null after replying.
  const suggestionSession = (
    payload: { boardId?: unknown } | null | undefined,
    reply: (refusal: SuggestionRefusal) => void,
  ): Session | null => {
    let refusal: SuggestionRefusal["reason"] | null = null;
    const session = isOnBoard(socket, payload?.boardId) ? getSession(socket.data.boardId!) : null;
    if (!limits.op()) refusal = "rate";
    else if (!session) refusal = "noSession";
    if (refusal) reply({ ok: false, reason: refusal });
    return refusal ? null : session!;
  };

  socket.on("suggestion:put", (payload, ack) => {
    const reply = typeof ack === "function" ? ack : () => {};
    const session = suggestionSession(payload, reply);
    if (!session) return;
    if (socket.data.role !== "suggester") return reply(SUGGESTION_FORBIDDEN);
    const sent = payload!.suggestions;
    if (!Array.isArray(sent)) return reply(SUGGESTION_INVALID);
    const { boardId } = session;
    // classroom mode: suggestions outside a student's frame are left out, as their changes are
    const zone = zoneIn(session, personOf(socket).userId, socket.data.boardRole);
    const outside: string[] = [];
    const drafts =
      zone === undefined
        ? sent
        : (sent as RawDraft[]).filter((draft) => {
            if (draftInside(draft, zone, session)) return true;
            const id = draft?.kind === "remove" ? draft.target : draft?.element?.id;
            if (typeof id === "string") outside.push(id);
            return false;
          });
    const result = putSuggestions(session.suggestions, session, personOf(socket), drafts);
    result.dropped.push(...outside);
    if (result.stored.length > 0) {
      for (const other of socketsIn(boardId)) {
        // in private mode, only to the author's other screens
        if (other !== socket && showsSuggestion(session, other)(result.stored[0])) {
          other.emit("suggestion:upsert", { boardId, suggestions: result.stored });
        }
      }
    }
    if (result.withdrawn.length > 0) {
      socket.to(boardId).emit("suggestion:delete", { boardId, ids: result.withdrawn, outcome: "withdrawn" });
    }
    if (result.stored.length + result.withdrawn.length > 0) markSuggestionsDirty(session);
    // a new suggestion (not a changed one) notifies the owner, at most once a minute per open board
    const made = result.stored.some((suggestion) => suggestion.createdAt === suggestion.updatedAt);
    if (made && !session.privateMode && Date.now() - (suggestionsNoted.get(session) ?? 0) > SUGGESTION_NOTICE_MS) {
      suggestionsNoted.set(session, Date.now());
      notifySuggestion(boardId, personOf(socket)).catch((error: unknown) => console.error(error));
    }
    reply({
      ok: true,
      suggestions: result.stored,
      ...(result.withdrawn.length > 0 ? { withdrawn: result.withdrawn } : {}),
      ...(result.dropped.length > 0 ? { dropped: result.dropped } : {}),
      ...(result.full ? { full: result.full } : {}),
    });
  });

  socket.on("suggestion:withdraw", (payload, ack) => {
    const reply = typeof ack === "function" ? ack : () => {};
    const session = suggestionSession(payload, reply);
    if (!session) return;
    const { boardId } = session;
    const ids = withdrawSuggestions(session.suggestions, personOf(socket), payload!.ids);
    if (ids.length > 0) {
      socket.to(boardId).emit("suggestion:delete", { boardId, ids, outcome: "withdrawn" });
      markSuggestionsDirty(session);
    }
    reply({ ok: true });
  });

  socket.on("suggestion:resolve", (payload, ack) => {
    const reply = typeof ack === "function" ? ack : () => {};
    const session = suggestionSession(payload, reply);
    if (!session) return;
    if (!isMemberRole(socket.data.role)) return reply(SUGGESTION_FORBIDDEN);
    const outcome = payload!.outcome;
    if (outcome !== "accepted" && outcome !== "rejected") return reply(SUGGESTION_INVALID);
    const { boardId } = session;
    const ids = resolveSuggestions(session.suggestions, payload!.ids);
    if (ids.length > 0) {
      socket.to(boardId).emit("suggestion:delete", { boardId, ids, outcome });
      markSuggestionsDirty(session);
    }
    reply({ ok: true });
  });

  socket.on("guest:rename", async (payload) => {
    if (socket.data.user) return;
    socket.data.guest!.name = cleanGuestName(payload?.name);
    if (!socket.data.boardId) return;
    // a frame they claimed in classroom mode shows their new name
    const session = getSession(socket.data.boardId);
    const { userId, name } = personOf(socket);
    const claims = session?.classroom?.claims;
    if (session && claims && [...claims.values()].some((claim) => claim.by === userId)) {
      for (const [frameId, claim] of claims) if (claim.by === userId) claims.set(frameId, { ...claim, name });
      announceClassroom(session);
    }
    await broadcastPresence(socket.data.boardId);
  });

  // in turn too: a join still under way may put the socket in a room after it went
  socket.on("disconnect", () => inTurn(() => leaveBoard(socket)));
}

async function joinBoard(socket: RealtimeSocket, payload: Untrusted<JoinPayload>, ack?: (reply: JoinReply) => void) {
  const reply = typeof ack === "function" ? ack : () => {};
  const requestedId = String(payload?.boardId ?? "");
  try {
    const userId = socket.data.user?.id ?? null;
    const pass = typeof payload?.pass === "string" ? payload.pass.slice(0, 200) : undefined;
    const board = await findBoardForViewing(requestedId, userId, { pass });
    // The database's id: the request may spell it differently (upper case hex), and a board must have one session and room
    // however it was asked for, or two people would save over each other and events would miss some.
    const boardId = board.id;
    // joining the board it's already on only refreshes it; otherwise leave first, so the elements read include what it just did
    if (socket.data.boardId !== boardId) await leaveBoard(socket);
    // before the socket is on the board: changes aren't queued behind a join, so one sent meanwhile is checked against this role
    socket.data.embed = payload?.embed === true;
    socket.data.boardRole = roleFor(socket, roleOf(board, userId, pass));
    socket.data.role = effectiveRole(socket, getSession(boardId));
    socket.data.pass = pass;
    // older browsers merge by older rules (see prepareOperation)
    socket.data.legacy = payload?.sync !== SYNC_FORMAT;
    socket.data.presenting = payload?.presenting === true;
    const session = await enterBoard(socket, boardId, requestedId);
    socket.data.role = effectiveRole(socket, session); // the board may have been opened just now, in private mode
    // many edit-link visitors may mean the link spread further than meant, so the owner is told (not in classroom mode,
    // where the link goes to a whole class)
    if (
      socket.data.boardRole === "contributor" &&
      !session.classroom?.on &&
      noteVisitor(watchOf(session), personOf(socket).userId)
    ) {
      warnOwner(boardId, "visitors", VISITORS_WARNING).catch((error: unknown) => console.error(error));
    }
    await openOwner(session); // looked up now, so it's known by the time they draw
    watchLinkExpiry(board);
    if (userId && !socket.data.embed) recordOpen(userId, boardId); // a board seen on another site isn't "opened"
    // they gave the password as a guest and have since logged in: they no longer need the pass
    if (userId && board.linkKey && !isMemberRole(socket.data.role)) await rememberUnlock(board, userId);

    // with the stamps of recently removed elements, so a change to one still on its way can't bring it back here
    reply({
      ok: true,
      board: serializeBoard(board, userId, session.elements, undefined, socket.data.role!),
      removed: removedStamps(session.tombstones),
      suggestions: suggestionList(session.suggestions).filter(showsSuggestion(session, socket)),
      countdown: countdownAt(session.countdown, Date.now()),
      privateMode: privateModeFor(session, socket),
      classroom: classroomOf(session, socket),
    });
    // a voting round under way, sent after the reply (which clears any this browser had)
    if (session.voting) socket.emit("voting", { boardId, voting: votingFor(session.voting, personOf(socket).userId) });
    await broadcastPresence(boardId);
  } catch (error) {
    if (!(error as Failure).status) console.error(error);
    reply({
      ok: false,
      status: (error as Failure).status ?? 500,
      error: (error as Failure).status ? (error as Failure).message : "This board couldn't be opened. Try again.",
      // a link needing a password, or expired, says which
      ...(error instanceof LinkLockedError && { locked: error.locked }),
    });
  }
}

// Joins the room and returns the open session, in one turn so it can't close in between. `requestedId` is the
// spelling the socket may keep using.
async function enterBoard(socket: RealtimeSocket, boardId: string, requestedId: string) {
  for (;;) {
    const session = await acquireSession(boardId);
    if (!holdSession(session)) continue; // it was closed, and saved, since: open it again
    socket.join(boardId);
    socket.data.boardId = boardId;
    socket.data.requestedId = requestedId;
    return session;
  }
}

async function leaveBoard(socket: RealtimeSocket) {
  holdGroup(socket, null);
  const boardId = socket.data.boardId;
  if (!boardId) return;
  socket.leave(boardId);
  socket.data.boardId = null;
  await handleDeparture(boardId);
}

async function handleDeparture(boardId: string) {
  if (!boardId) return;
  const remaining = io.sockets.adapter.rooms.get(boardId)?.size ?? 0;
  if (remaining === 0) {
    await closeSession(boardId);
  } else {
    await broadcastPresence(boardId);
  }
}

async function broadcastPresence(boardId: string) {
  const sockets = await io.in(boardId).fetchSockets();
  // the board id comes second so older browsers, which expect just the list, still read it
  io.to(boardId).emit(
    "presence",
    sockets
      .filter((s) => !s.data.embed)
      .map((s) => ({ socketId: s.id, ...personOf(s), ...(s.data.presenting && { presenting: true }) })),
    { boardId },
  );
}

function socketsIn(room: string) {
  const ids = io?.sockets.adapter.rooms.get(room) ?? [];
  // drops the ids of sockets that have gone since
  return [...ids].map((id) => io.sockets.sockets.get(id)).filter(Boolean) as RealtimeSocket[];
}

// Hooks used by the REST API so open boards react to changes immediately.

type BoardDetails = Parameters<typeof serializeMeta>[0];

// only members see email addresses
export function notifyMetaChanged(board: BoardDetails) {
  for (const socket of socketsIn(board.id)) {
    socket.emit("board:meta", serializeMeta(board, { redact: !isMemberRole(socket.data.role) }));
  }
}

// Re-checks everyone with the board open after an access change: drops those who lost access, re-roles the rest.
export async function syncAccess(board: BoardDetails) {
  if (!io) return;
  let dropped = false;
  for (const socket of socketsIn(board.id)) {
    const userId = socket.data.user?.id ?? null;
    const role = roleFor(socket, roleOf(board, userId, socket.data.pass));
    if (!role) {
      // names the link's password or expiry, so the person can give the password or knows why
      const locked = (board.linkAccess !== "restricted" && linkLock(board, userId, socket.data.pass)) || undefined;
      socket.emit("board:revoked", { boardId: board.id, ...(locked && { locked }) });
      socket.leave(board.id);
      socket.data.boardId = null;
      holdGroup(socket, null);
      dropped = true;
    } else {
      socket.data.boardRole = role;
      const session = getSession(board.id);
      const effective = effectiveRole(socket, session);
      if (effective !== socket.data.role) {
        socket.data.role = effective;
        socket.emit("board:role", { boardId: board.id, role: effective! });
      }
      // invited or not, they may have become a student in classroom mode, or stopped being one
      if (session?.classroom) socket.emit("classroom", { boardId: board.id, classroom: classroomOf(session, socket) });
    }
  }
  if (dropped) await handleDeparture(board.id);
  notifyMetaChanged(board);
}

const expiryTimers = new Map<string, ReturnType<typeof setTimeout>>();
// setTimeout can't wait longer than this; a later expiry is watched once someone joins nearer the time.
const LONGEST_TIMER_MS = 2 ** 31 - 1;

// Drops people who opened by the link when it expires (see syncAccess), not at their next reconnect. Called when the
// expiry is set and on join.
export function watchLinkExpiry(board: { id: string; linkExpiresAt?: Date | null }) {
  clearTimeout(expiryTimers.get(board.id));
  expiryTimers.delete(board.id);
  const wait = (board.linkExpiresAt?.getTime() ?? Infinity) - Date.now();
  if (wait > LONGEST_TIMER_MS) return;
  const timer = setTimeout(
    async () => {
      expiryTimers.delete(board.id);
      try {
        const current = await Board.findOne({ _id: board.id, deletedAt: null })
          .select("-elements")
          .populate<PopulatedMembers>(populateMembers);
        if (current) await syncAccess(current);
      } catch (error) {
        console.error(`Couldn't close an expired link: ${(error as Error).message}`);
      }
    },
    Math.max(0, wait) + 100,
  );
  timer.unref();
  expiryTimers.set(board.id, timer);
}

export async function replaceElements(boardId: string, snapshot: Element[], actor?: { name: string } | null) {
  // always through the open board, so someone opening it right now can't put the old one back
  const session = await acquireSession(boardId);
  const elements = resetSession(session, snapshot);
  io?.to(boardId).emit("board:reset", {
    boardId,
    elements,
    removed: removedStamps(session.tombstones),
    by: actor?.name ?? null,
  });
  // suggestions about elements the restore took away go; suggested additions it brought back are on the board
  if (io) announceSettled(session, settleSuggestions(session.suggestions, session));
  // with nobody on it the board is saved and released (someone opening it meanwhile keeps it open)
  if (!io?.sockets.adapter.rooms.has(boardId)) await closeSession(boardId);
  return elements;
}

// comments are shown only to signed-in people
export function emitToSignedIn(boardId: string, event: "thread:upsert", payload: Thread): void;
export function emitToSignedIn(boardId: string, event: "thread:delete", payload: ThreadRemoval): void;
export function emitToSignedIn(
  boardId: string,
  event: "thread:upsert" | "thread:delete",
  payload: Thread | ThreadRemoval,
) {
  for (const socket of socketsIn(boardId)) {
    // the overloads already match event to payload, which emit can't follow from a union
    if (socket.data.user) socket.emit(event as "thread:upsert", payload as Thread);
  }
}

export function notifyUser(userId: string, notification: NotificationItem) {
  io?.to(`user:${userId}`).emit("notification", notification);
}

export function disconnectUser(userId: string) {
  for (const socket of socketsIn(`user:${userId}`)) socket.disconnect(true);
}

export async function refreshUser(user: { id: string; toPublic(): PublicUser }) {
  const boards = new Set<string>();
  for (const socket of socketsIn(`user:${user.id}`)) {
    socket.data.user = user.toPublic();
    if (socket.data.boardId) boards.add(socket.data.boardId);
  }
  await Promise.all([...boards].map(broadcastPresence));
}

// A trashed board keeps its latest changes so it can be restored as it was.
export async function closeBoard(boardId: string, { keepChanges = false }: { keepChanges?: boolean } = {}) {
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
