import { useCallback, useEffect, useRef, useState } from "react";
import type { Dispatch, SetStateAction } from "react";
import { MAX_ZOOM } from "../constants/board";
import { fitViewport } from "../lib/elements/geometry";
import type { Size, Viewport } from "../lib/elements/geometry";
import type { BoardSync, SharedView } from "./useBoardSync";

const SAME_ENOUGH = 0.5; // a view this close to ours (in screen pixels, and in zoom steps) isn't worth moving to

// The assertions: Boolean() has ruled out null and undefined, which TypeScript doesn't see through it.
export const sameView = (a: Viewport | null | undefined, b: Viewport | null | undefined) =>
  Boolean(a && b) && a!.x === b!.x && a!.y === b!.y && a!.zoom === b!.zoom;

export function followedViewport(current: Viewport, view: SharedView, canvasSize: Size): Viewport {
  const visible = { x: -view.x, y: -view.y, width: view.width / view.zoom, height: view.height / view.zoom };
  const next = fitViewport(visible, canvasSize, { padding: 0, maxZoom: MAX_ZOOM });
  const same =
    Math.abs(next.x - current.x) * current.zoom < SAME_ENOUGH &&
    Math.abs(next.y - current.y) * current.zoom < SAME_ENOUGH &&
    Math.abs(next.zoom / current.zoom - 1) < 0.001;
  return same ? current : next;
}

type FollowOptions = { sync: BoardSync; canvasSize: Size; setViewport: Dispatch<SetStateAction<Viewport>> };

export type Follow = ReturnType<typeof useFollow>;

// Following fits their view's rectangle into our canvas, so it works across screen sizes. Our own view is shared
// for others to follow but `followedView` isn't: two people following each other would pass it back and forth,
// growing a little on each trip.
export function useFollow({ sync, canvasSize, setViewport }: FollowOptions) {
  const [followingId, setFollowingId] = useState<string | null>(null);
  const followedView = useRef<Viewport | null>(null);

  const { subscribeViewport, requestViewport, peers, socketId } = sync;
  const stopFollowing = useCallback(() => setFollowingId(null), []);

  // Someone presenting is followed from when they start (or we arrive) until they stop, or we move ourselves.
  const presenterId = peers.find((peer) => peer.presenting && peer.socketId !== socketId)?.socketId ?? null;
  const [seenPresenter, setSeenPresenter] = useState<string | null>(null);
  if (presenterId !== seenPresenter) {
    setSeenPresenter(presenterId);
    if (seenPresenter) setFollowingId((id) => (id === seenPresenter ? null : id));
    if (presenterId) setFollowingId(presenterId);
  }

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

  if (followingId && !peers.some((peer) => peer.socketId === followingId)) setFollowingId(null);

  return { followingId, follow: setFollowingId, stopFollowing, followedView };
}
