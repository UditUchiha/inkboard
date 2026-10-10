import { useCallback, useEffect, useRef, useState } from "react";
import { MAX_ZOOM } from "./constants";
import { fitViewport } from "./geometry";

const SAME_ENOUGH = 0.5; // a view this close to ours (in screen pixels, and in zoom steps) isn't worth moving to

/** Whether two views are the same one (a followed view is worked out the same way each time, so exactly). */
export const sameView = (a, b) => Boolean(a && b) && a.x === b.x && a.y === b.y && a.zoom === b.zoom;

/** Our view after following `view` (a collaborator's, as they send it), or `current` itself if that's no change. */
export function followedViewport(current, view, canvasSize) {
  const visible = { x: -view.x, y: -view.y, width: view.width / view.zoom, height: view.height / view.zoom };
  const next = fitViewport(visible, canvasSize, { padding: 0, maxZoom: MAX_ZOOM });
  const same =
    Math.abs(next.x - current.x) * current.zoom < SAME_ENOUGH &&
    Math.abs(next.y - current.y) * current.zoom < SAME_ENOUGH &&
    Math.abs(next.zoom / current.zoom - 1) < 0.001;
  return same ? current : next;
}

/**
 * Follow mode: while following someone, our view tracks theirs. Their view is
 * a rectangle of the board; we fit that rectangle into our own canvas, so
 * following works across different screen sizes. Following ends when the
 * person leaves, or when we pan or zoom ourselves (`stopFollowing`).
 *
 * `followedView` holds the view we last took from them. Our own view is shared
 * for others to follow, but that one mustn't be: two people following each
 * other would pass it back and forth, growing a little on each trip.
 */
export function useFollow({ sync, canvasSize, setViewport }) {
  const [followingId, setFollowingId] = useState(null); // a socket id
  const followedView = useRef(null);

  const { subscribeViewport, requestViewport, peers } = sync;
  const stopFollowing = useCallback(() => setFollowingId(null), []);

  useEffect(() => {
    if (!followingId || !canvasSize.width) return undefined;
    const unsubscribe = subscribeViewport((view) => {
      if (view.socketId !== followingId) return;
      setViewport((current) => {
        const next = followedViewport(current, view, canvasSize);
        if (next !== current) followedView.current = next;
        return next;
      });
    });
    requestViewport(followingId);
    return unsubscribe;
  }, [followingId, canvasSize, subscribeViewport, requestViewport, setViewport]);

  useEffect(() => {
    if (followingId && !peers.some((peer) => peer.socketId === followingId)) setFollowingId(null);
  }, [peers, followingId]);

  return { followingId, follow: setFollowingId, stopFollowing, followedView };
}
