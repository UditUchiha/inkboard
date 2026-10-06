import { useCallback, useEffect, useState } from "react";
import { MAX_ZOOM } from "./constants";
import { fitViewport } from "./geometry";

/**
 * Follow mode: while following someone, our view tracks theirs. Their view is
 * a rectangle of the board; we fit that rectangle into our own canvas, so
 * following works across different screen sizes. Following ends when the
 * person leaves, or when we pan or zoom ourselves (`stopFollowing`).
 */
export function useFollow({ sync, canvasSize, setViewport }) {
  const [followingId, setFollowingId] = useState(null); // a socket id

  const { subscribeViewport, requestViewport, peers } = sync;
  const stopFollowing = useCallback(() => setFollowingId(null), []);

  useEffect(() => {
    if (!followingId || !canvasSize.width) return undefined;
    const unsubscribe = subscribeViewport((view) => {
      if (view.socketId !== followingId) return;
      const visible = { x: -view.x, y: -view.y, width: view.width / view.zoom, height: view.height / view.zoom };
      setViewport(fitViewport(visible, canvasSize, { padding: 0, maxZoom: MAX_ZOOM }));
    });
    requestViewport(followingId);
    return unsubscribe;
  }, [followingId, canvasSize, subscribeViewport, requestViewport, setViewport]);

  useEffect(() => {
    if (followingId && !peers.some((peer) => peer.socketId === followingId)) setFollowingId(null);
  }, [peers, followingId]);

  return { followingId, follow: setFollowingId, stopFollowing };
}
