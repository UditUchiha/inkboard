import type { Element as BoardElement, Effect, Stamp } from "@inkboard/shared/types";
import { useCallback, useEffect, useRef, useState } from "react";
import { toast } from "sonner";
import type { LinkAccess, Person } from "../../lib/api";
import { useSocket } from "../../providers/SocketProvider";
import { SYNC_FORMAT } from "./constants";
import { createCursorStore } from "./cursors";
import type { XY, Viewport } from "./geometry";
import { createOutbox } from "./outbox";
import type { Piece, SettleResult } from "./outbox";
import type { BoardStore } from "./store";

const CURSOR_INTERVAL_MS = 50;
const VIEWPORT_INTERVAL_MS = 120;
const ACK_TIMEOUT_MS = 10_000;
const SLOW_TOAST = { id: "saving-slow" }; // one message however often it's said

// What to tell the person when the server refuses a change for good (see outbox.js).
const REFUSED: Record<string, string> = {
  tooLarge:
    "That change was too big to save, so it was undone. The board may be full: delete something or start a new board.",
  forbidden: "You can only view this board now, so your last change wasn't saved.",
  ownerFull:
    "This board's owner has used up their space, so that change was undone. Delete something or empty the trash to make room.",
  invalid: "That change couldn't be saved, so it was undone.",
};

// The shapes below are the ones the server declares for its socket events (ClientToServerEvents and
// ServerToClientEvents in server/src/realtime/index.ts), as far as the browser reads them. They are written out
// here because the browser doesn't import server code.

/** What a person may do on a board: "owner" and "editor" can draw, "contributor" is a guest on an edit link. */
export type Role = "owner" | "editor" | "contributor" | "viewer";

/** Someone on the board or listed on it. Only the board's members come with an email address. */
export type Member = Person & { email?: string };

/** A board's details: what the server sends when joining (without the drawing) and again when they change. */
export type BoardMeta = {
  id: string;
  title: string;
  owner: Member;
  collaborators: Member[];
  linkAccess: LinkAccess;
  createdAt: string;
  updatedAt: string;
};

/** A tombstone as the server tells of it when a board is opened. */
export type RemovedStamp = Stamp & { id: string };

/** The reply to joining a board: the board as this person may see it, with the stamps of what was removed lately. */
export type JoinReply =
  | {
      ok: true;
      board: BoardMeta & { role: Role; starred: boolean; elements: BoardElement[] };
      removed: RemovedStamp[];
    }
  | { ok: false; status: number; error: string };

/**
 * Why a change was refused. `tooLarge` and `readOnly` are also set where older browsers, which look for
 * them, need to see them.
 */
export type OpRefusal = {
  ok: false;
  reason: "rate" | "noSession" | "invalid" | "tooLarge" | "forbidden" | "expired" | "ownerFull";
  tooLarge?: true;
  readOnly?: true;
};

/** The reply to a change: taken in (with `cleaned`, elements as the board stored them where that isn't how they were sent, and `dropped`, ids of elements it refused), or refused. */
export type OpReply = { ok: true; cleaned?: BoardElement[]; dropped?: string[] } | OpRefusal;

/** Someone on the board, as presence lists them. A guest has no color or avatar. */
export type Participant = {
  userId: string;
  name: string;
  color?: string | null;
  avatarUrl?: string | null;
  guest: boolean;
};

/** A participant with the id of the connection they are on, which is what follows and pointers are told apart by. */
export type Peer = Participant & { socketId: string };

/** A person's pointer: where it is on the board, or no position when it has left the board's view. */
export type CursorMessage = { socketId: string } & ({ x: number; y: number } | { x?: undefined; y?: undefined });

/** The part of the board someone is looking at: where it is, how far in, and how big their canvas is. */
export type SharedView = Viewport & { width: number; height: number };

/** One person's view of the board, passed on to the others so they can follow along. */
export type ViewportMessage = SharedView & {
  boardId: string;
  socketId: string;
  // Whose own view it is, when it's one taken from someone they follow.
  source: string;
};

/** Told of every view someone else shares (see subscribeViewport). */
export type ViewportListener = (view: ViewportMessage) => void;

/** Where opening the board has got to. */
export type Phase =
  | { name: "connecting" }
  | { name: "error"; status: number; message?: string }
  | { name: "ready" }
  | { name: "deleted" }
  | { name: "revoked"; wasViewer: boolean };

/** What the board's other events carry, so one meant for the board we left can be told from ours. */
type ForBoard = { boardId?: string };

/** What the sync hook gives the editor: where opening the board has got to, who is here, and how to share a view. */
export type BoardSync = ReturnType<typeof useBoardSync>;

/**
 * Connects a board store to the server: joins the board's room, streams local
 * changes (batched every 40ms), applies collaborators' changes, and tracks
 * presence and cursors. Edits made while offline are queued and sent after
 * reconnecting. The queue and what to do with the server's replies are in outbox.js.
 *
 * `boardId` may be undefined only because the router types it so: the board's route always has one.
 */
export function useBoardSync(boardId: string | undefined, store: BoardStore) {
  const socket = useSocket();
  const [phase, setPhase] = useState<Phase>({ name: "connecting" });
  const [meta, setMeta] = useState<BoardMeta | null>(null);
  const [role, setRole] = useState<Role>("viewer"); // "owner" | "editor" can draw; "viewer" can only look
  const [peers, setPeers] = useState<Peer[]>([]);
  const [online, setOnline] = useState(false);
  const [saving, setSaving] = useState(false);
  const [cursors] = useState(createCursorStore);
  const [outbox] = useState(() => createOutbox({ onChange: setSaving }));

  const flushTimer = useRef<ReturnType<typeof setTimeout> | null>(null);
  const joined = useRef(false);
  const loaded = useRef(false);
  const roleRef = useRef<Role>("viewer");
  const peerCount = useRef(0);
  const latestViewport = useRef<{ view: SharedView; followed: string | null } | null>(null); // what we're looking at, see sendViewport
  const viewSources = useRef(new Map<string, string>()); // socket id -> whose own view they're showing (see onViewport)
  const viewportTimer = useRef<ReturnType<typeof setTimeout> | null>(null);
  const viewportListeners = useRef(new Set<ViewportListener>());
  const resync = useRef(() => {}); // shows the board as the server has it, dropping unsent changes
  const rejoin = useRef(() => {}); // joins again, keeping unsent changes on top
  const onReply = useRef<(result: SettleResult) => void>(() => {}); // what to do with the server's answer to a change (set below)

  const send = useCallback(
    (piece: Piece) => {
      const payload = { boardId, op: piece.op, ...(piece.group ? { group: piece.group } : {}) };
      // The assertion: a piece is only sent once there is a socket (see flush, and the replies and cleanup that send).
      socket!
        .timeout(ACK_TIMEOUT_MS)
        .emit("board:op", payload, (error: Error | null, response: OpReply | undefined) => {
          onReply.current(outbox.settle(piece.seq, error, response));
        });
    },
    [socket, boardId, outbox],
  );

  const flush = useCallback(() => {
    // The cast, here and below: clearTimeout takes null as well as undefined, which the DOM types don't say.
    clearTimeout(flushTimer.current as number | undefined);
    flushTimer.current = null;
    if (!socket || !joined.current) return;
    const piece = outbox.take();
    if (piece) send(piece);
  }, [socket, outbox, send]);

  // Our view as it's sent: with whose own view it is (`source`), ours, or, when it's one we took
  // from someone we follow, whoever's they took it from. Someone following us never takes their
  // own view back (see onViewport), so people following one another can't pass one round.
  const viewportMessage = useCallback(() => {
    // The assertion: both callers have looked for a view first.
    const { view, followed } = latestViewport.current!;
    return { ...view, source: followed ? (viewSources.current.get(followed) ?? followed) : socket?.id };
  }, [socket]);

  onReply.current = (result: SettleResult) => {
    if (result.kind === "ok") {
      if (result.cleaned.length > 0 || result.dropped.length > 0) store.reconcile(result);
      if (result.dropped.length > 0) {
        const count = result.dropped.length;
        toast.error(
          `The board is full, so ${count === 1 ? "1 element" : `${count} elements`} couldn't be added. Delete something or start a new board.`,
        );
      }
      if (result.next) send(result.next);
      // A change in pieces is done: what was made meanwhile waited for it (see outbox.js).
      else if (outbox.hasPending() && joined.current) flushTimer.current ??= setTimeout(flush, 0);
    } else if (result.kind === "retry" || result.kind === "rejoin") {
      // A reconnect in the meantime showed the board as the server has it,
      // which may not include this change yet. Merging it in again is harmless otherwise.
      if (result.again.upsert.length > 0 || result.again.remove.length > 0) store.applyRemote(result.again);
      if (result.kind === "rejoin") {
        // The server has no record of us being on this board: join again, then send.
        joined.current = false;
        rejoin.current();
      } else if (joined.current) {
        flushTimer.current ??= setTimeout(flush, result.delay);
      }
      // The server keeps turning changes away: they stay queued, and are sent again as it allows.
      // The cast: only a retry has `slow` (a rejoin reads as undefined).
      if ((result as { slow?: boolean }).slow)
        toast("Saving is taking longer than usual. Your changes are kept and will go through.", SLOW_TOAST);
    } else if (result.kind === "resync") {
      // Retrying can't help. Put this screen back to what everyone else has, so it
      // doesn't keep a drawing that was never saved.
      toast.error(REFUSED[result.reason] ?? REFUSED.invalid);
      resync.current();
    }
  };

  useEffect(() => {
    store.setBroadcaster((op) => {
      outbox.add(op);
      flushTimer.current ??= setTimeout(flush, outbox.flushDelay());
    });
    return () => store.setBroadcaster(() => {});
  }, [store, outbox, flush]);

  useEffect(() => {
    if (!socket) return undefined;
    let active = true;
    let joining = false;
    let gone = false; // the board was deleted, or we can't see it any more: nothing joins it again
    // The board's id as events name it. The server names a board by its own spelling of the id (lower
    // case), whichever way the address spelled it, so that is taken from the reply to joining.
    // The assertion: see the parameter.
    let eventId = boardId!.toLowerCase();

    // Another board in the same screen: nothing of the last one may carry over,
    // above all changes not sent yet, which would otherwise be sent to this board.
    if (outbox.switchTo(boardId!)) {
      loaded.current = false;
      joined.current = false;
      roleRef.current = "viewer";
      setPhase({ name: "connecting" });
      setMeta(null);
      setRole("viewer");
      setPeers([]);
      cursors.clear();
    }

    const join = () => {
      if (joining || gone) return;
      joining = true;
      socket.emit("board:join", { boardId, sync: SYNC_FORMAT }, (response: JoinReply) => {
        joining = false;
        if (!active) return;
        if (!response?.ok) {
          setPhase({ name: "error", status: response?.status ?? 500, message: response?.error });
          return;
        }
        const { elements, role: joinedRole, ...boardMeta } = response.board;
        if (boardMeta.id) eventId = String(boardMeta.id).toLowerCase();
        roleRef.current = joinedRole;
        setRole(joinedRole);
        if (loaded.current) {
          // Reconnected: keep any edits made while offline on top of the server state.
          store.rejoin(elements, outbox.unsent(), response.removed);
        } else {
          store.load(elements, response.removed);
          if (outbox.hasPending()) store.applyRemote(outbox.unsent()); // drawn while this was loading
          loaded.current = true;
        }
        setMeta(boardMeta);
        joined.current = true;
        setPhase({ name: "ready" });
        flush();
      });
    };

    rejoin.current = join;
    resync.current = () => {
      outbox.reset();
      loaded.current = false;
      joined.current = false;
      join();
    };

    const onConnect = () => {
      setOnline(true);
      joining = false;
      join();
    };
    const onDisconnect = () => {
      joined.current = false;
      joining = false;
      // What was sent and not confirmed may be lost. It goes out again after joining, and shows on top
      // of the board as the server has it, instead of vanishing for a while.
      outbox.requeueSent();
      setOnline(false);
      setPeers([]);
      cursors.clear();
    };
    // Events for the board we were on before, sent before the server saw us leave it, are left out.
    // (Servers before this one don't say which board an event is for.)
    const forOther = (payload: ForBoard) =>
      Boolean(payload?.boardId) && String(payload.boardId).toLowerCase() !== eventId;
    const onOp = (payload: { boardId: string; op: Effect }) => {
      if (!forOther(payload)) store.applyRemote(payload.op);
    };
    const onPresence = (list: Peer[], about: { boardId: string }) => {
      if (forOther(about)) return;
      peerCount.current = list.length;
      setPeers(list);
      cursors.keepOnly(list.map((peer) => peer.socketId));
    };
    const onCursor = ({ socketId, x, y }: CursorMessage) => cursors.move(socketId, x === undefined ? null : { x, y });
    const onMeta = (next: BoardMeta) => {
      if (!next?.id || String(next.id).toLowerCase() === eventId) setMeta((current) => ({ ...current, ...next }));
    };
    // A reply that comes after this (a change the server no longer has a board for) must not join
    // again, which would put an error in place of saying what happened.
    const leaveForGood = () => {
      gone = true;
      joined.current = false;
      rejoin.current = () => {};
      resync.current = () => {};
    };
    const onDeleted = (payload: { boardId: string }) => {
      if (forOther(payload)) return;
      leaveForGood();
      setPhase({ name: "deleted" });
    };
    // Someone restored an earlier version: everything on the board is replaced.
    const onReset = (payload: {
      boardId: string;
      elements: BoardElement[];
      removed: RemovedStamp[];
      by: string | null;
    }) => {
      if (forOther(payload)) return;
      const { elements, removed, by } = payload;
      outbox.reset();
      store.load(elements, removed);
      // Same id as the restorer's own toast in VersionHistory, so they see one message, not two.
      toast(by ? `${by} restored an earlier version of this board` : "An earlier version of this board was restored", {
        id: "board-restored",
      });
    };
    const onViewport = (view: ViewportMessage) => {
      if (forOther(view)) return;
      // Our own view, passed back by someone following us (perhaps through others who follow them):
      // taking it would send it round again, a little bigger each time on screens of other shapes.
      if (view.source === socket.id) return;
      viewSources.current.set(view.socketId, view.source ?? view.socketId);
      for (const listener of viewportListeners.current) listener(view);
    };
    // Someone started following us: send our view right away instead of waiting for a pan.
    const onViewportRequest = (payload: { boardId: string }) => {
      if (!forOther(payload) && latestViewport.current) socket.volatile.emit("viewport", viewportMessage());
    };
    const onRevoked = (payload: { boardId: string }) => {
      if (forOther(payload)) return;
      leaveForGood();
      setPhase({ name: "revoked", wasViewer: roleRef.current === "viewer" });
    };
    const onRole = (payload: { boardId: string; role: Role }) => {
      if (forOther(payload)) return;
      const nextRole = payload.role;
      const lostEditing = roleRef.current !== "viewer" && nextRole === "viewer";
      roleRef.current = nextRole;
      setRole(nextRole);
      if (lostEditing) resync.current(); // drop unsent edits and history
    };

    socket.on("connect", onConnect);
    socket.on("disconnect", onDisconnect);
    socket.on("board:op", onOp);
    socket.on("presence", onPresence);
    socket.on("cursor", onCursor);
    socket.on("board:meta", onMeta);
    socket.on("board:deleted", onDeleted);
    socket.on("board:revoked", onRevoked);
    socket.on("board:role", onRole);
    socket.on("board:reset", onReset);
    socket.on("viewport", onViewport);
    socket.on("viewport:request", onViewportRequest);
    if (socket.connected) onConnect();

    return () => {
      active = false;
      resync.current = () => {}; // a late reply must not re-join a board we've left
      rejoin.current = () => {};
      // Everything not sent yet goes now, the rest of a change in pieces too, ahead of leaving: the
      // server would refuse what came after (and forget a group it had only part of).
      clearTimeout(flushTimer.current as number | undefined);
      flushTimer.current = null;
      if (joined.current) for (const piece of outbox.drain()) send(piece);
      joined.current = false;
      socket.emit("board:leave");
      socket.off("connect", onConnect);
      socket.off("disconnect", onDisconnect);
      socket.off("board:op", onOp);
      socket.off("presence", onPresence);
      socket.off("cursor", onCursor);
      socket.off("board:meta", onMeta);
      socket.off("board:deleted", onDeleted);
      socket.off("board:revoked", onRevoked);
      socket.off("board:role", onRole);
      socket.off("board:reset", onReset);
      socket.off("viewport", onViewport);
      socket.off("viewport:request", onViewportRequest);
    };
  }, [socket, boardId, store, outbox, cursors, flush, send, viewportMessage]);

  // What part of the board we're looking at, shared (when anyone else is here) so
  // others can follow along: always what's on screen, also while following someone
  // (`followed`: their socket id, when `view` is the one taken from them), so whoever
  // follows us sees it too. Trailing-edge throttled so the final position is always sent.
  const sendViewport = useCallback(
    (view: SharedView, followed: string | null = null) => {
      latestViewport.current = { view, followed };
      if (viewportTimer.current) return;
      viewportTimer.current = setTimeout(() => {
        viewportTimer.current = null;
        if (socket && joined.current && peerCount.current > 1 && latestViewport.current) {
          socket.volatile.emit("viewport", viewportMessage());
        }
      }, VIEWPORT_INTERVAL_MS);
    },
    [socket, viewportMessage],
  );

  const subscribeViewport = useCallback((listener: ViewportListener): (() => void) => {
    viewportListeners.current.add(listener);
    return () => viewportListeners.current.delete(listener);
  }, []);

  const requestViewport = useCallback((socketId: string) => socket?.emit("viewport:request", { socketId }), [socket]);

  // Throttled, but the last position is always sent, so a pointer that came to rest shows where it stopped.
  const lastCursorAt = useRef(0);
  const cursorTimer = useRef<ReturnType<typeof setTimeout> | null>(null);
  const latestCursor = useRef<XY | null>(null);
  useEffect(() => () => clearTimeout(cursorTimer.current as number | undefined), []);
  const sendCursor = useCallback(
    (point: XY | null) => {
      if (!socket || !joined.current) return;
      const emit = (position: XY | null) => {
        lastCursorAt.current = performance.now();
        socket.volatile.emit("cursor", position ?? {});
      };
      latestCursor.current = point;
      const wait = CURSOR_INTERVAL_MS - (performance.now() - lastCursorAt.current);
      if (!point || wait <= 0) {
        clearTimeout(cursorTimer.current as number | undefined);
        cursorTimer.current = null;
        emit(point);
      } else {
        cursorTimer.current ??= setTimeout(() => {
          cursorTimer.current = null;
          if (joined.current) emit(latestCursor.current);
        }, wait);
      }
    },
    [socket],
  );

  return {
    phase,
    meta,
    setMeta,
    role,
    peers,
    cursors, // a store (see cursors.js): only what draws the pointers subscribes
    online,
    saving,
    sendCursor,
    sendViewport,
    subscribeViewport,
    requestViewport,
    socket,
    socketId: socket?.id,
  };
}
