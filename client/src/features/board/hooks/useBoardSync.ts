import type { LinkLock, Wire } from "@inkboard/shared/api";
import type {
  BoardMessage,
  Classroom,
  ClassroomMessage,
  Countdown,
  CountdownMessage,
  CursorMessage,
  JoinReply as SocketJoinReply,
  OpMessage,
  PrivateMode,
  PrivateModeMessage,
  OpReply,
  Peer,
  ResetMessage,
  RevokedMessage,
  RoleMessage,
  SharedView,
  SuggestionPutReply,
  SuggestionRemovalMessage,
  SuggestionsMessage,
  ViewportMessage,
  Voting,
  VotingMessage,
} from "@inkboard/shared/socket";
import type { SuggestionDraft } from "@inkboard/shared/suggestions";
import { useEffect, useRef, useState } from "react";
import { toast } from "sonner";
import type { BoardMeta, Role } from "../../../lib/api";
import { readPass } from "../../../lib/linkPasses";
import { useSocket } from "../../../providers/SocketProvider";
import { SYNC_FORMAT } from "../constants/board";
import { createCursorStore } from "../lib/render/cursors";
import { createOutbox } from "../lib/sync/outbox";
import type { BoardStore } from "../lib/sync/store";
import { createSuggester } from "../lib/sync/suggesting";
import { createSuggestionStore } from "../lib/sync/suggestions";
import { useCursorSending } from "./useCursorSending";
import { useOutboxSender } from "./useOutboxSender";
import { useSessionCommands } from "./useSessionCommands";
import { useViewportSharing } from "./useViewportSharing";

// What to tell a suggester when some of what they suggested wasn't kept, by the limit it met.
const SUGGESTION_REFUSED: Record<"author" | "board" | "other", string> = {
  author:
    "You have as many suggestions waiting as you can, so that one was undone. More can be made once some are decided.",
  board: "This board has as many suggestions waiting as it can hold, so that one was undone.",
  other: "That couldn't be suggested (pictures can't be, for one), so it was undone.",
};

// Socket payload types live in @inkboard/shared/socket; dates in a reply arrive as strings (see Wire).
export type { CursorMessage, OpReply, Peer, SharedView, ViewportMessage };
export type { OpRefusal, Participant, RemovedStamp } from "@inkboard/shared/socket";

export type JoinReply = Wire<SocketJoinReply>;

export type ViewportListener = (view: ViewportMessage) => void;

export type Phase =
  | { name: "connecting" }
  | { name: "error"; status: number; message?: string; locked?: LinkLock }
  | { name: "ready" }
  | { name: "deleted" }
  | { name: "revoked"; wasViewer: boolean };

// What other events carry, so one meant for the board we left can be told from ours.
type ForBoard = { boardId?: string };

export const drawsOnBoard = (role: Role) => role !== "viewer" && role !== "suggester";

export type BoardSync = ReturnType<typeof useBoardSync>;

// Batches local changes every 40ms and applies collaborators'; offline edits are queued (see outbox.ts). A suggester's
// edits go as suggestions (see suggesting.ts); `selfId` tells theirs apart.
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
  const [role, setRole] = useState<Role>("viewer");
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
  const resync = useRef(() => {}); // shows the board as the server has it, dropping unsent changes
  const rejoin = useRef(() => {}); // joins again, keeping unsent changes on top

  const { send, flush } = useOutboxSender({
    socket,
    boardId,
    store,
    outbox,
    suggester,
    roleRef,
    joined,
    flushTimer,
    rejoin,
    resync,
  });
  const {
    viewportMessage,
    sendViewport,
    subscribeViewport,
    requestViewport,
    latestViewport,
    viewSources,
    viewportListeners,
  } = useViewportSharing(socket, joined, peerCount);

  useEffect(() => {
    if (!socket) return undefined;
    let active = true;
    let joining = false;
    let gone = false; // the board was deleted, or we can't see it any more: nothing joins it again
    // The server names a board by its own spelling of the id (lower case), so take it from the reply to joining.
    let eventId = boardId.toLowerCase();

    // Another board on the same screen: nothing of the last one may carry over, above all unsent changes.
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
      // What was sent and not confirmed may be lost: it goes out again after joining and shows on top meanwhile.
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
      store.applyRemote(payload.op, outbox.typing());
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
    // A late reply must not join again, which would put an error in place of saying what happened.
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
      // Our own view, passed back by someone following us: taking it would send it round again, a little bigger each time.
      if (view.source === socket.id) return;
      viewSources.current.set(view.socketId, view.source ?? view.socketId);
      for (const listener of viewportListeners.current) listener(view);
    };
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
      if (lostEditing || suggesting) resync.current();
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
      // Everything unsent goes now, ahead of leaving: the server would refuse what came after and forget a half-received group.
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
  }, [
    socket,
    boardId,
    embed,
    store,
    outbox,
    cursors,
    suggestions,
    suggester,
    flush,
    send,
    viewportMessage,
    latestViewport,
    viewSources,
    viewportListeners,
  ]);

  const sendCursor = useCursorSending(socket, joined);
  const commands = useSessionCommands({
    socket,
    boardId,
    joined,
    presenting,
    rejoin,
    suggestions,
    suggester,
    sendSuggestions,
    setPhase,
  });

  return {
    phase,
    meta,
    setMeta,
    role,
    peers,
    cursors, // a store (see cursors.ts): only what draws the pointers subscribes
    suggestions, // a store too (see suggestions.ts)
    ...commands,
    voting,
    // The board as the server has it, without a suggester's own suggestions (see suggesting.ts).
    suggestedOver: suggester.board,
    online,
    saving,
    sendCursor,
    sendViewport,
    timer,
    privateMode,
    classroom,
    subscribeViewport,
    requestViewport,
    socket,
    socketId: socket?.id,
  };
}
