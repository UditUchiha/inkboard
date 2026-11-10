import { useCallback, useEffect, useLayoutEffect, useRef, useState } from "react";
import type { Dispatch, SetStateAction } from "react";
import { getBounds, getSceneBounds } from "../lib/elements/elements";
import { fitViewport, zoomAround } from "../lib/elements/geometry";
import type { Viewport } from "../lib/elements/geometry";
import { viewToReveal } from "../lib/elements/placement";
import type { BoardStore } from "../lib/sync/store";
import type { BoardSync } from "./useBoardSync";
import { sameView, useFollow } from "./useFollow";
import type { ImportView } from "./useImageImport";

export function useEditorViewport(store: BoardStore, sync: BoardSync) {
  const [viewport, setViewport] = useState<Viewport>({ x: 0, y: 0, zoom: 1 });
  const [canvasSize, setCanvasSize] = useState({ width: 0, height: 0 });

  const { followingId, follow, stopFollowing, followedView } = useFollow({ sync, canvasSize, setViewport });
  const changeViewport = useCallback(
    (next: Viewport | ((current: Viewport) => Viewport)) => {
      stopFollowing();
      setViewport(next);
    },
    [stopFollowing],
  );

  // Share what's on screen so others can follow; a view taken from someone we follow is sent as theirs, so two people
  // following each other don't pass it back and forth (see sendViewport).
  const { sendViewport } = sync;
  useEffect(() => {
    if (!canvasSize.width) return;
    const followed = followingId && sameView(viewport, followedView.current) ? followingId : null;
    sendViewport({ ...viewport, width: canvasSize.width, height: canvasSize.height }, followed);
  }, [viewport, canvasSize, sendViewport, followedView, followingId]);

  const [fitted, setFitted] = useState(false);
  if (!fitted && canvasSize.width) {
    setFitted(true);
    const bounds = getSceneBounds(store.getElements());
    if (bounds) setViewport(fitViewport(bounds, canvasSize, { padding: 96, maxZoom: 1 }));
  }

  const zoomBy = useCallback(
    (factor: number) =>
      changeViewport((vp) => zoomAround(vp, vp.zoom * factor, canvasSize.width / 2, canvasSize.height / 2)),
    [canvasSize, changeViewport],
  );
  const resetZoom = () => changeViewport((vp) => zoomAround(vp, 1, canvasSize.width / 2, canvasSize.height / 2));
  const fitToScreen = useCallback(() => {
    const bounds = getSceneBounds(store.getElements());
    if (bounds) changeViewport(fitViewport(bounds, canvasSize, { padding: 96, maxZoom: 2 }));
  }, [store, canvasSize, changeViewport]);

  const visibleArea = () => ({
    x: -viewport.x,
    y: -viewport.y,
    width: canvasSize.width / viewport.zoom,
    height: canvasSize.height / viewport.zoom,
  });

  const view = useRef<ImportView>({ viewport, canvasSize });
  useLayoutEffect(() => {
    view.current = { viewport, canvasSize };
  });

  return {
    viewport,
    setViewport,
    canvasSize,
    setCanvasSize,
    followingId,
    follow,
    stopFollowing,
    changeViewport,
    zoomBy,
    resetZoom,
    fitToScreen,
    visibleArea,
    view,
  };
}

// Selecting from the keyboard list or while connecting can pick an off-screen element: bring it into view, only when the
// selection changes (not on resize) and without leaving someone we follow.
export function useRevealInView(
  store: BoardStore,
  view: { current: ImportView },
  setViewport: Dispatch<SetStateAction<Viewport>>,
  id: string | null,
) {
  useEffect(() => {
    const { viewport, canvasSize } = view.current;
    const element = id && canvasSize.width ? store.getElement(id) : null;
    if (!element) return;
    const next = viewToReveal(viewport, canvasSize, getBounds(element));
    if (next !== viewport) setViewport(next);
  }, [id, store, view, setViewport]);
}

export type EditorViewport = ReturnType<typeof useEditorViewport>;
