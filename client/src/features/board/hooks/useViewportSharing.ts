import { useCallback, useRef } from "react";
import type { RefObject } from "react";
import type { AppSocket } from "../../../providers/SocketProvider";
import type { SharedView, ViewportListener } from "./useBoardSync";

const VIEWPORT_INTERVAL_MS = 120;

// Sharing our view so others can follow it, and handing theirs to whoever follows them.
export function useViewportSharing(socket: AppSocket | null, joined: RefObject<boolean>, peerCount: RefObject<number>) {
  const latestViewport = useRef<{ view: SharedView; followed: string | null } | null>(null); // what we're looking at, see sendViewport
  const viewSources = useRef(new Map<string, string>()); // socket id -> whose own view they're showing (see onViewport)
  const viewportTimer = useRef<ReturnType<typeof setTimeout> | null>(null);
  const viewportListeners = useRef(new Set<ViewportListener>());

  // Our view with whose own it is (`source`): ours, or whoever's it was before we took it by following. Someone
  // following us never takes their own view back (see onViewport), so people following one another can't pass one
  // round.
  const viewportMessage = useCallback(() => {
    // The assertion: both callers have looked for a view first.
    const { view, followed } = latestViewport.current!;
    return { ...view, source: followed ? (viewSources.current.get(followed) ?? followed) : socket?.id };
  }, [socket]);

  // Shared (when anyone else is here) so others can follow: always what's on screen, also while following (`followed`
  // is their socket id when `view` was taken from them). Trailing-edge throttled so the final position is always sent.
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
    [socket, joined, peerCount, viewportMessage],
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

  return {
    latestViewport,
    viewSources,
    viewportListeners,
    viewportMessage,
    sendViewport,
    subscribeViewport,
    requestViewport,
  };
}
