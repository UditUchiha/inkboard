import type { LinkLock, Wire } from "@inkboard/shared/api";
import type {
  BoardMessage,
  Classroom,
  ClassroomMessage,
  ClassroomPayload,
  Countdown,
  CountdownMessage,
  CountdownPayload,
  CursorMessage,
  CursorPayload,
  JoinReply as SocketJoinReply,
  OpMessage,
  PrivateMode,
  PrivateModeMessage,
  OpReply,
  Peer,
  ReplayReply,
  ResetMessage,
  RevokedMessage,
  RoleMessage,
  SharedView,
  SuggestionOutcome,
  SuggestionPutReply,
  SuggestionRemovalMessage,
  SuggestionsMessage,
  ViewportMessage,
  VotePayload,
  Voting,
  VotingMessage,
} from "@inkboard/shared/socket";
import type { SuggestionDraft } from "@inkboard/shared/suggestions";
import { useCallback, useEffect, useRef, useState } from "react";
import { toast } from "sonner";
import { api } from "../../lib/api";
import type { BoardMeta, Role } from "../../lib/api";
import { readPass, savePass } from "../../lib/linkPasses";
import { useSocket } from "../../providers/SocketProvider";
import { SYNC_FORMAT } from "./constants";
import { createCursorStore } from "./cursors";
import type { XY } from "./geometry";
import { createOutbox } from "./outbox";
import type { Piece, SettleResult } from "./outbox";
import type { BoardStore } from "./store";
import { createSuggester } from "./suggesting";
import { createSuggestionStore } from "./suggestions";

const CURSOR_INTERVAL_MS = 50;
const VIEWPORT_INTERVAL_MS = 120;
const ACK_TIMEOUT_MS = 10_000;
const SLOW_TOAST = { id: "saving-slow" }; // one message however often it's said

// What to tell a suggester when some of what they suggested wasn't kept, by the limit it met.
const SUGGESTION_REFUSED: Record<"author" | "board" | "other", string> = {
  author:
    "You have as many suggestions waiting as you can, so that one was undone. More can be made once some are decided.",
  board: "This board has as many suggestions waiting as it can hold, so that one was undone.",
  other: "That couldn't be suggested (pictures can't be, for one), so it was undone.",
};

// What to tell the person when the server refuses a change for good (see outbox.ts).
const REFUSED: Record<string, string> = {
  tooLarge:
    "That change was too big to save, so it was undone. The board may be full: delete something or start a new board.",
  forbidden: "You can only view this board now, so your last change wasn't saved.",
  ownerFull:
    "This board's owner has used up their space, so that change was undone. Delete something or empty the trash to make room.",
  invalid: "That change couldn't be saved, so it was undone.",
  outside: "That change was outside your frame, so it was undone.",
};

/** Told when, in classroom mode, something a student did outside their frame was put back (see useBoardSync). */
export const OUTSIDE_FRAME = "In classroom mode you can change only what's inside your frame, so that was put back.";

// The shapes of what the socket carries are declared once, in @inkboard/shared/socket, and are exported from here
// by the names the rest of the app uses. A reply that carries dates arrives with them as strings (see Wire).
export type { CursorMessage, OpReply, Peer, SharedView, ViewportMessage };
export type { OpRefusal, Participant, RemovedStamp } from "@inkboard/shared/socket";

/** The reply to joining a board: the board as this person may see it, with the stamps of what was removed lately. */
export type JoinReply = Wire<SocketJoinReply>;

/** Told of every view someone else shares (see subscribeViewport). */
export type ViewportListener = (view: ViewportMessage) => void;

/** Where opening the board has got to. */
export type Phase =
  | { name: "connecting" }
  | { name: "error"; status: number; message?: string; locked?: LinkLock }
  | { name: "ready" }
  | { name: "deleted" }
  | { name: "revoked"; wasViewer: boolean };

/** What the board's other events carry, so one meant for the board we left can be told from ours. */
type ForBoard = { boardId?: string };

/** Whether someone with `role` changes the board itself: viewers only look, and suggesters' changes are suggestions. */
export const drawsOnBoard = (role: Role) => role !== "viewer" && role !== "suggester";

/** What the sync hook gives the editor: where opening the board has got to, who is here, and how to share a view. */
export type BoardSync = ReturnType<typeof useBoardSync>;

/**
 * Connects a board store to the server: joins the board's room, streams local
 * changes (batched every 40ms), applies collaborators' changes, and tracks
 * presence and cursors. Edits made while offline are queued and sent after
 * reconnecting. The queue and what to do with the server's replies are in outbox.ts.
 * Someone who may only suggest has their edits sent as suggestions instead (see
 * suggesting.ts); `selfId` (their account's id, or their guest id) tells theirs apart.
 */
/** The board's timer as this browser keeps it: as the server last said, and when (by this browser's clock) it heard. */
export type BoardTimer = Countdown & { at: number };

const timerFrom = (countdown: Countdown | null | undefined): BoardTimer | null =>
  countdown ? { ...countdown, at: Date.now() } : null;

export function useBoardSync(
  boardId: string,
  store: BoardStore,
  { selfId, embed = false }: { selfId: string; embed?: boolean },
) {
  const socket = useSocket();
  const [phase, setPhase] = useState<Phase>({ name: "connecting" });
  const [meta, setMeta] = useState<BoardMeta | null>(null);
  const [role, setRole] = useState<Role>("viewer"); // "owner" | "editor" can draw; "viewer" can only look
  const [peers, setPeers] = useState<Peer[]>([]);
  const [timer, setTimer] = useState<BoardTimer | null>(null);
  const [privateMode, setPrivateMode] = useState<PrivateMode | null>(null);
  const [classroom, setClassroom] = useState<Classroom | null>(null);
  const [online, setOnline] = useState(false);
  const [saving, setSaving] = useState(false);
  const [cursors] = useState(createCursorStore);
  const [suggestions] = useState(createSuggestionStore);
  const [voting, setVoting] = useState<Voting | null>(null);
  const [outbox] = useState(() => createOutbox({ onChange: setSaving }));
  // How suggestions are sent: set below, once the socket is known (the suggester is made only once).
  const sendSuggestions = useRef<(drafts: SuggestionDraft[], withdraw: string[]) => Promise<SuggestionPutReply>>(() =>
    Promise.resolve({ ok: false, reason: "noSession" }),
  );
  // (Someone can log in while on the board, so whose suggestions are theirs is read as it is now.)
  const self = useRef(selfId);
  self.current = selfId;
  const [suggester] = useState(() =>
    createSuggester({
      store,
      suggestions,
      isOwn: (suggestion) => suggestion.author.userId === self.current,
      send: (drafts, withdraw) => sendSuggestions.current(drafts, withdraw),
      onRefused: ({ full }) => toast.error(SUGGESTION_REFUSED[full ?? "other"]),
    }),
  );
  useEffect(() => {
    suggester.start();
    return () => suggester.stop();
  }, [suggester]);

  const flushTimer = useRef<ReturnType<typeof setTimeout> | null>(null);
  const joined = useRef(false);
  const loaded = useRef(false);
  const roleRef = useRef<Role>("viewer");
  const presenting = useRef(false); // see present
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
    // The cast, here and below: clearTimeout takes null as well as undefined, which its types don't say.
    clearTimeout(flushTimer.current as ReturnType<typeof setTimeout> | undefined);
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
      if (result.cleaned.length > 0 || result.dropped.length > 0 || result.restored.length > 0) {
        store.reconcile(result);
      }
      // In classroom mode, what a student did outside their frame was left out (and put back here).
      if (result.outside) toast(OUTSIDE_FRAME, { id: OUTSIDE_FRAME });
      else if (result.dropped.length > 0) {
        const count = result.dropped.length;
        toast.error(
          `The board is full, so ${count === 1 ? "1 element" : `${count} elements`} couldn't be added. Delete something or start a new board.`,
        );
      }
      if (result.next) send(result.next);
      // A change in pieces is done: what was made meanwhile waited for it (see outbox.ts).
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
      // A suggester's changes are suggestions, not changes to the board.
      if (roleRef.current === "suggester") {
        suggester.take(op);
        return;
      }
      outbox.add(op);
      flushTimer.current ??= setTimeout(flush, outbox.flushDelay());
    });
    return () => store.setBroadcaster(() => {});
  }, [store, outbox, flush, suggester]);

  sendSuggestions.current = (drafts, withdraw) =>
    new Promise((resolve) => {
      if (!socket || !joined.current) return resolve({ ok: false, reason: "noSession" });
      if (withdraw.length > 0) socket.emit("suggestion:withdraw", { boardId, ids: withdraw }, () => {});
      if (drafts.length === 0) return resolve({ ok: true, suggestions: [] });
      socket
        .timeout(ACK_TIMEOUT_MS)
        .emit("suggestion:put", { boardId, suggestions: drafts }, (error: Error | null, reply?: SuggestionPutReply) =>
          resolve(error || !reply ? { ok: false, reason: "noSession" } : reply),
        );
    });

  useEffect(() => {
    if (!socket) return undefined;
    let active = true;
    let joining = false;
    let gone = false; // the board was deleted, or we can't see it any more: nothing joins it again
    // The board's id as events name it. The server names a board by its own spelling of the id (lower
    // case), whichever way the address spelled it, so that is taken from the reply to joining.
    let eventId = boardId.toLowerCase();

    // Another board in the same screen: nothing of the last one may carry over,
    // above all changes not sent yet, which would otherwise be sent to this board.
    if (outbox.switchTo(boardId)) {
      loaded.current = false;
      joined.current = false;
      roleRef.current = "viewer";
      setPhase({ name: "connecting" });
      setMeta(null);
      setRole("viewer");
      setPeers([]);
      setTimer(null);
      setPrivateMode(null);
      setClassroom(null);
      cursors.clear();
      suggestions.clear();
      suggester.forget();
      setVoting(null);
    }

    const join = () => {
      if (joining || gone) return;
      joining = true;
      const pass = readPass(boardId);
      // An embed (see EmbedPage) only views, and isn't shown to the others.
      const flags = { ...(presenting.current && { presenting: true }), ...(embed && { embed }) };
      socket.emit("board:join", { boardId, sync: SYNC_FORMAT, ...(pass && { pass }), ...flags }, (response) => {
        joining = false;
        if (!active) return;
        if (!response?.ok) {
          setPhase({
            name: "error",
            status: response?.status ?? 500,
            message: response?.error,
            locked: response?.locked,
          });
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
        // A server from before suggestions doesn't send any.
        suggestions.load(response.suggestions ?? []);
        setTimer(timerFrom(response.countdown));
        setPrivateMode(response.privateMode ?? null);
        setClassroom(response.classroom ?? null);
        // A suggester sees the board with their suggestions on it.
        if (joinedRole === "suggester") suggester.joined(elements, response.removed);
        setMeta(boardMeta);
        // A round of voting under way is sent next; one that ended while this browser was away is gone.
        setVoting(null);
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
    const onOp = (payload: OpMessage) => {
      if (forOther(payload)) return;
      store.applyRemote(payload.op);
      if (roleRef.current === "suggester") suggester.remote(payload.op);
    };
    const onPresence = (list: Peer[], about: BoardMessage) => {
      if (forOther(about)) return;
      peerCount.current = list.length;
      setPeers(list);
      cursors.keepOnly(list.map((peer) => peer.socketId));
    };
    const onCursor = ({ socketId, x, y, laser }: CursorMessage) =>
      cursors.move(socketId, x === undefined ? null : { x, y, ...(laser && { laser }) });
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
    const onDeleted = (payload: BoardMessage) => {
      if (forOther(payload)) return;
      leaveForGood();
      setPhase({ name: "deleted" });
    };
    // Someone restored an earlier version: everything on the board is replaced.
    const onReset = (payload: ResetMessage) => {
      if (forOther(payload)) return;
      const { elements, removed, by } = payload;
      outbox.reset();
      store.load(elements, removed);
      if (roleRef.current === "suggester") suggester.reset(elements, removed);
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
    const onViewportRequest = (payload: BoardMessage) => {
      if (!forOther(payload) && latestViewport.current) socket.volatile.emit("viewport", viewportMessage());
    };
    const onRevoked = (payload: RevokedMessage) => {
      if (forOther(payload)) return;
      if (payload.locked) {
        // The link's password changed, or it expired: they can open the board again once they give the new one.
        joined.current = false;
        setPhase({ name: "error", status: 403, locked: payload.locked });
        return;
      }
      leaveForGood();
      setPhase({ name: "revoked", wasViewer: !drawsOnBoard(roleRef.current) });
    };
    const onRole = (payload: RoleMessage) => {
      if (forOther(payload)) return;
      const nextRole = payload.role;
      const lostEditing = drawsOnBoard(roleRef.current) && !drawsOnBoard(nextRole);
      // Starting or stopping suggesting changes what this screen shows: the board with their suggestions on it, or not.
      const suggesting = (roleRef.current === "suggester") !== (nextRole === "suggester");
      roleRef.current = nextRole;
      setRole(nextRole);
      if (suggesting) suggester.forget();
      if (lostEditing || suggesting) resync.current(); // drop unsent edits and history
    };
    const onCountdown = (payload: CountdownMessage) => {
      if (!forOther(payload)) setTimer(timerFrom(payload.countdown));
    };
    const onClassroom = (payload: ClassroomMessage) => {
      if (!forOther(payload)) setClassroom(payload.classroom);
    };
    const onPrivateMode = (payload: PrivateModeMessage) => {
      if (!forOther(payload)) setPrivateMode(payload.privateMode);
    };
    const onSuggestions = (payload: SuggestionsMessage) => {
      if (!forOther(payload)) suggestions.upsert(payload.suggestions);
    };
    const onSuggestionsGone = (payload: SuggestionRemovalMessage) => {
      if (forOther(payload)) return;
      // A suggester's own suggestion that went any way but into the board: show the board without it.
      const gone = new Set(payload.ids);
      const own = suggestions.getSnapshot().some((item) => gone.has(item.id) && item.author.userId === self.current);
      suggestions.remove(payload.ids);
      if (own && payload.outcome !== "accepted" && roleRef.current === "suggester") suggester.rebuild();
    };
    const onVoting = (payload: VotingMessage) => {
      if (!forOther(payload)) setVoting(payload.voting);
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
    socket.on("countdown", onCountdown);
    socket.on("private", onPrivateMode);
    socket.on("classroom", onClassroom);
    socket.on("suggestion:upsert", onSuggestions);
    socket.on("suggestion:delete", onSuggestionsGone);
    socket.on("voting", onVoting);
    if (socket.connected) onConnect();

    return () => {
      active = false;
      resync.current = () => {}; // a late reply must not re-join a board we've left
      rejoin.current = () => {};
      // Everything not sent yet goes now, the rest of a change in pieces too, ahead of leaving: the
      // server would refuse what came after (and forget a group it had only part of).
      clearTimeout(flushTimer.current as ReturnType<typeof setTimeout> | undefined);
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
      socket.off("countdown", onCountdown);
      socket.off("private", onPrivateMode);
      socket.off("classroom", onClassroom);
      socket.off("suggestion:upsert", onSuggestions);
      socket.off("suggestion:delete", onSuggestionsGone);
      socket.off("voting", onVoting);
    };
  }, [socket, boardId, embed, store, outbox, cursors, suggestions, suggester, flush, send, viewportMessage]);

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

  const requestViewport = useCallback(
    (socketId: string) => {
      socket?.emit("viewport:request", { socketId });
    },
    [socket],
  );

  // Throttled, but the last position is always sent, so a pointer that came to rest shows where it stopped.
  const lastCursorAt = useRef(0);
  const cursorTimer = useRef<ReturnType<typeof setTimeout> | null>(null);
  const latestCursor = useRef<CursorPayload>({});
  useEffect(() => () => clearTimeout(cursorTimer.current as ReturnType<typeof setTimeout> | undefined), []);
  const sendCursor = useCallback(
    (point: XY | null, laser = false) => {
      if (!socket || !joined.current) return;
      const emit = (payload: CursorPayload) => {
        lastCursorAt.current = performance.now();
        socket.volatile.emit("cursor", payload);
      };
      latestCursor.current = point ? { ...point, ...(laser && { laser }) } : {};
      const wait = CURSOR_INTERVAL_MS - (performance.now() - lastCursorAt.current);
      if (!point || wait <= 0) {
        clearTimeout(cursorTimer.current as ReturnType<typeof setTimeout> | undefined);
        cursorTimer.current = null;
        emit(latestCursor.current);
      } else {
        cursorTimer.current ??= setTimeout(() => {
          cursorTimer.current = null;
          if (joined.current) emit(latestCursor.current);
        }, wait);
      }
    },
    [socket],
  );

  // The board's replay (see replay.ts), for members and, when the owner lets them, people who came by the link.
  const loadReplay = useCallback(
    (): Promise<ReplayReply> =>
      new Promise((resolve) => {
        if (!socket || !joined.current) resolve({ ok: false, error: "You're offline. Try again once you're back." });
        else socket.emit("board:replay", { boardId }, resolve);
      }),
    [socket, boardId],
  );

  // Starting or stopping a presentation: the others are shown who presents, and follow them (see useFollow).
  // Remembered, so a reconnect joins as the presenter again.
  const present = useCallback(
    (on: boolean) => {
      presenting.current = on;
      if (joined.current) socket?.emit("present", { on });
    },
    [socket],
  );

  // Starting, pausing, resuming or stopping the board's timer. Everyone, this browser too, hears back what it is now.
  const controlTimer = useCallback(
    (payload: CountdownPayload) => {
      socket?.emit("countdown", payload);
    },
    [socket],
  );

  // Turning private mode on or off (see PrivateMode). Everyone, this browser too, hears back what it is now.
  const setPrivate = useCallback(
    (on: boolean) => {
      socket?.emit("private", { on });
    },
    [socket],
  );

  // Classroom mode (see Classroom): a member starts or stops it or frees a frame, a student claims one. Resolves with
  // whether it was done; everyone, this browser too, hears back what it is now.
  const changeClassroom = useCallback(
    (payload: ClassroomPayload) =>
      new Promise<boolean>((resolve) => {
        if (!socket?.connected) return resolve(false);
        socket
          .timeout(10_000)
          .emit("classroom", payload, (error: Error | null, reply?: { ok: boolean }) =>
            resolve(!error && reply?.ok === true),
          );
      }),
    [socket],
  );

  // A member's decision on suggestions. They go from this screen at once; accepting one is the member's own
  // change to the board, made before this (see acceptance in suggestions.ts).
  const resolveSuggestions = useCallback(
    (ids: string[], outcome: SuggestionOutcome) => {
      if (ids.length === 0) return;
      suggestions.remove(ids);
      socket?.emit("suggestion:resolve", { boardId, ids, outcome }, (reply) => {
        if (!reply?.ok) toast.error("That decision couldn't be saved. Open the board again and try once more.");
      });
    },
    [socket, boardId, suggestions],
  );

  // Dot voting: running a round, and casting or taking back a vote. Everyone hears back the round as they see it.
  const vote = useCallback(
    (payload: VotePayload) => {
      socket?.emit("vote", payload);
    },
    [socket],
  );

  // Gives the password the board's link asks for, keeps the pass it gets, and opens the board with it. Rejects
  // with the server's reason (a wrong password, say), for the form to show.
  const unlock = useCallback(
    async (password: string) => {
      const { pass } = await api.unlockBoard(boardId, password);
      savePass(boardId, pass);
      setPhase({ name: "connecting" });
      rejoin.current();
    },
    [boardId],
  );

  // A suggester taking back their own suggestions: the board shows without them again.
  const withdrawSuggestions = useCallback(
    (ids: string[]) => {
      if (ids.length === 0) return;
      suggestions.remove(ids);
      socket?.emit("suggestion:withdraw", { boardId, ids }, () => {});
      suggester.rebuild();
    },
    [socket, boardId, suggestions, suggester],
  );

  return {
    phase,
    meta,
    setMeta,
    role,
    peers,
    cursors, // a store (see cursors.ts): only what draws the pointers subscribes
    suggestions, // a store too (see suggestions.ts)
    resolveSuggestions,
    withdrawSuggestions,
    voting,
    vote,
    unlock,
    // The board as the server has it, without a suggester's own suggestions (see suggesting.ts).
    suggestedOver: suggester.board,
    online,
    saving,
    sendCursor,
    sendViewport,
    loadReplay,
    present,
    timer,
    controlTimer,
    privateMode,
    setPrivate,
    classroom,
    changeClassroom,
    subscribeViewport,
    requestViewport,
    socket,
    socketId: socket?.id,
  };
}
