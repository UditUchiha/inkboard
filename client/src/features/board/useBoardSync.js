import { useCallback, useEffect, useRef, useState } from "react";
import { useSocket } from "../../providers/SocketProvider";
import { applyOperation } from "./store";

const FLUSH_INTERVAL_MS = 40;
const CURSOR_INTERVAL_MS = 50;
const ACK_TIMEOUT_MS = 10_000;

function toOperation(pending) {
  const op = { upsert: [], remove: [] };
  for (const [id, element] of pending) {
    if (element) op.upsert.push(element);
    else op.remove.push(id);
  }
  return op;
}

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

  const flush = useCallback(() => {
    clearTimeout(flushTimer.current);
    flushTimer.current = null;
    if (!socket || !joined.current || pending.current.size === 0) return;

    const op = toOperation(pending.current);
    pending.current.clear();
    const seq = ++sequence.current;
    for (const element of op.upsert) lastSent.current.set(element.id, seq);
    for (const id of op.remove) lastSent.current.set(id, seq);

    setInflight((count) => count + 1);
    socket.timeout(ACK_TIMEOUT_MS).emit("board:op", { boardId, op }, (error, response) => {
      setInflight((count) => count - 1);
      if (!error && response?.ok) return;
      // Not confirmed: queue it again unless a newer change already superseded it.
      for (const element of op.upsert) {
        if (lastSent.current.get(element.id) === seq && !pending.current.has(element.id)) {
          pending.current.set(element.id, element);
        }
      }
      for (const id of op.remove) {
        if (lastSent.current.get(id) === seq && !pending.current.has(id)) pending.current.set(id, null);
      }
      if (joined.current) flushTimer.current ??= setTimeout(flush, FLUSH_INTERVAL_MS * 10);
    });
  }, [socket, boardId]);

  useEffect(() => {
    store.setBroadcaster((op) => {
      for (const element of op.upsert ?? []) pending.current.set(element.id, element);
      for (const id of op.remove ?? []) pending.current.set(id, null);
      flushTimer.current ??= setTimeout(flush, FLUSH_INTERVAL_MS);
    });
    return () => store.setBroadcaster(() => {});
  }, [store, flush]);

  useEffect(() => {
    if (!socket) return undefined;
    let active = true;

    const join = () => {
      socket.emit("board:join", { boardId }, (response) => {
        if (!active) return;
        if (!response?.ok) {
          setPhase({ name: "error", status: response?.status ?? 500, message: response?.error });
          return;
        }
        const { elements, ...boardMeta } = response.board;
        if (loaded.current) {
          // Reconnected: keep any edits made while offline on top of the server state.
          store.replace(applyOperation(elements, toOperation(pending.current)));
        } else {
          store.load(elements);
          loaded.current = true;
        }
        setMeta(boardMeta);
        joined.current = true;
        setPhase({ name: "ready" });
        flush();
      });
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
    const onRevoked = () => {
      joined.current = false;
      setPhase({ name: "revoked" });
    };

    socket.on("connect", onConnect);
    socket.on("disconnect", onDisconnect);
    socket.on("board:op", onOp);
    socket.on("presence", onPresence);
    socket.on("cursor", onCursor);
    socket.on("board:meta", onMeta);
    socket.on("board:deleted", onDeleted);
    socket.on("board:revoked", onRevoked);
    if (socket.connected) onConnect();

    return () => {
      active = false;
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
    };
  }, [socket, boardId, store, flush]);

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

  return { phase, meta, setMeta, peers, cursors, online, saving, sendCursor, socketId: socket?.id };
}
