import { useCallback, useEffect, useRef, useState } from "react";
import { toast } from "sonner";
import { useSocket } from "../../providers/SocketProvider";
import { toOperation, toOperations } from "./store";

const FLUSH_INTERVAL_MS = 40;
const CURSOR_INTERVAL_MS = 50;
const VIEWPORT_INTERVAL_MS = 120;
const ACK_TIMEOUT_MS = 10_000;
// Which rules for merging changes this app follows. 2: each element's property
// groups carry their own stamps (see shared/src/board-merge.js).
const SYNC_FORMAT = 2;

/**
 * Connects a board store to the server: joins the board's room, streams local
 * changes (batched every 40ms), applies collaborators' changes, and tracks
 * presence and cursors. Edits made while offline are queued and sent after
 * reconnecting.
 */
export function useBoardSync(boardId, store) {
  const socket = useSocket();
  const [phase, setPhase] = useState({ name: "connecting" });
  const [meta, setMeta] = useState(null);
  const [role, setRole] = useState("viewer"); // "owner" | "editor" can draw; "viewer" can only look
  const [peers, setPeers] = useState([]);
  const [cursors, setCursors] = useState({});
  const [online, setOnline] = useState(false);
  const [inflight, setInflight] = useState(0);

  const pending = useRef(new Map()); // id -> element | null (removed)
  const lastSent = useRef(new Map()); // id -> sequence number of the last op that included it
  const sequence = useRef(0);
  const flushTimer = useRef(null);
  const joined = useRef(false);
  const loaded = useRef(false);
  const roleRef = useRef("viewer");
  const peerCount = useRef(0);
  const latestViewport = useRef(null);
  const viewportTimer = useRef(null);
  const viewportListeners = useRef(new Set());
  const resync = useRef(() => {}); // shows the board as the server has it, dropping unsent changes

  const flush = useCallback(() => {
    clearTimeout(flushTimer.current);
    flushTimer.current = null;
    if (!socket || !joined.current || pending.current.size === 0) return;

    const operations = toOperations(pending.current);
    pending.current.clear();
    for (const op of operations) {
      const seq = ++sequence.current;
      for (const element of op.upsert) lastSent.current.set(element.id, seq);
      for (const removal of op.remove) lastSent.current.set(removal.id, seq);

      setInflight((count) => count + 1);
      socket.timeout(ACK_TIMEOUT_MS).emit("board:op", { boardId, op }, (error, response) => {
        setInflight((count) => count - 1);
        if (!error && response?.ok) return;
        if (response?.readOnly) return; // Access was lowered; retrying would never succeed.
        if (response?.tooLarge) {
          // Retrying can't help. Put this screen back to what everyone else has, so it
          // doesn't keep a drawing that was never saved.
          toast.error(
            "That change was too big to save, so it was undone. The board may be full: delete something or start a new board.",
          );
          resync.current();
          return;
        }
        // Not confirmed: queue it again unless a newer change already superseded it.
        const again = { upsert: [], remove: [] };
        for (const element of op.upsert) {
          if (lastSent.current.get(element.id) === seq && !pending.current.has(element.id)) {
            pending.current.set(element.id, element);
            again.upsert.push(element);
          }
        }
        for (const removal of op.remove) {
          if (lastSent.current.get(removal.id) === seq && !pending.current.has(removal.id)) {
            pending.current.set(removal.id, { removal });
            again.remove.push(removal);
          }
        }
        // A reconnect in the meantime showed the board as the server has it,
        // which may not include this change yet. Merging it in again is harmless otherwise.
        if (again.upsert.length > 0 || again.remove.length > 0) store.applyRemote(again);
        if (joined.current) flushTimer.current ??= setTimeout(flush, FLUSH_INTERVAL_MS * 10);
      });
    }
  }, [socket, boardId, store]);

  useEffect(() => {
    store.setBroadcaster((op) => {
      for (const element of op.upsert ?? []) pending.current.set(element.id, element);
      for (const removal of op.remove ?? []) pending.current.set(removal.id, { removal });
      flushTimer.current ??= setTimeout(flush, FLUSH_INTERVAL_MS);
    });
    return () => store.setBroadcaster(() => {});
  }, [store, flush]);

  useEffect(() => {
    if (!socket) return undefined;
    let active = true;

    const join = () => {
      socket.emit("board:join", { boardId, sync: SYNC_FORMAT }, (response) => {
        if (!active) return;
        if (!response?.ok) {
          setPhase({ name: "error", status: response?.status ?? 500, message: response?.error });
          return;
        }
        const { elements, role: joinedRole, ...boardMeta } = response.board;
        roleRef.current = joinedRole;
        setRole(joinedRole);
        if (loaded.current) {
          // Reconnected: keep any edits made while offline on top of the server state.
          store.rejoin(elements, toOperation(pending.current), response.removed);
        } else {
          store.load(elements, response.removed);
          loaded.current = true;
        }
        setMeta(boardMeta);
        joined.current = true;
        setPhase({ name: "ready" });
        flush();
      });
    };

    resync.current = () => {
      pending.current.clear();
      loaded.current = false;
      join();
    };

    const onConnect = () => {
      setOnline(true);
      join();
    };
    const onDisconnect = () => {
      joined.current = false;
      setOnline(false);
      setPeers([]);
      setCursors({});
    };
    const onOp = ({ op }) => store.applyRemote(op);
    const onPresence = (list) => {
      peerCount.current = list.length;
      setPeers(list);
      const present = new Set(list.map((peer) => peer.socketId));
      setCursors((current) => Object.fromEntries(Object.entries(current).filter(([id]) => present.has(id))));
    };
    const onCursor = ({ socketId, x, y }) => {
      setCursors((current) => {
        if (x === undefined) {
          const { [socketId]: _removed, ...rest } = current;
          return rest;
        }
        return { ...current, [socketId]: { x, y } };
      });
    };
    const onMeta = (next) => setMeta((current) => ({ ...current, ...next }));
    const onDeleted = () => setPhase({ name: "deleted" });
    // Someone restored an earlier version: everything on the board is replaced.
    const onReset = ({ elements, removed, by }) => {
      pending.current.clear();
      store.load(elements, removed);
      toast(by ? `${by} restored an earlier version of this board` : "An earlier version of this board was restored");
    };
    const onViewport = (view) => {
      for (const listener of viewportListeners.current) listener(view);
    };
    // Someone started following us: send our view right away instead of waiting for a pan.
    const onViewportRequest = () => {
      if (latestViewport.current) socket.volatile.emit("viewport", latestViewport.current);
    };
    const onRevoked = () => {
      joined.current = false;
      setPhase({ name: "revoked", wasViewer: roleRef.current === "viewer" });
    };
    const onRole = ({ role: nextRole }) => {
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
      flush();
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
  }, [socket, boardId, store, flush]);

  // What part of the board we're looking at, shared (when anyone else is here) so
  // others can follow along. Trailing-edge throttled so the final position is always sent.
  const sendViewport = useCallback(
    (view) => {
      latestViewport.current = view;
      if (viewportTimer.current) return;
      viewportTimer.current = setTimeout(() => {
        viewportTimer.current = null;
        if (socket && joined.current && peerCount.current > 1 && latestViewport.current) {
          socket.volatile.emit("viewport", latestViewport.current);
        }
      }, VIEWPORT_INTERVAL_MS);
    },
    [socket],
  );

  const subscribeViewport = useCallback((listener) => {
    viewportListeners.current.add(listener);
    return () => viewportListeners.current.delete(listener);
  }, []);

  const requestViewport = useCallback((socketId) => socket?.emit("viewport:request", { socketId }), [socket]);

  const lastCursorAt = useRef(0);
  const sendCursor = useCallback(
    (point) => {
      if (!socket || !joined.current) return;
      const now = performance.now();
      if (point && now - lastCursorAt.current < CURSOR_INTERVAL_MS) return;
      lastCursorAt.current = now;
      socket.volatile.emit("cursor", point ?? {});
    },
    [socket],
  );

  const saving = inflight > 0 || pending.current.size > 0;

  return {
    phase,
    meta,
    setMeta,
    role,
    peers,
    cursors,
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
