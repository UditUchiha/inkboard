import { useCallback, useEffect, useMemo, useState } from "react";
import type { Element as BoardElement } from "@inkboard/shared/types";
import { MAX_ZOOM } from "../constants/board";
import { getBounds } from "../lib/elements/elements";
import { slideFrames } from "../lib/elements/order";
import { fitViewport } from "../lib/elements/geometry";
import type { Size, Viewport, XY } from "../lib/elements/geometry";
import type { BoardSync } from "./useBoardSync";

interface PresentingOptions {
  sync: BoardSync;
  elements: BoardElement[];
  selectedId: string | null;
  setSelectedId: (id: string | null) => void;
  canvasSize: Size;
  changeViewport: (next: Viewport) => void;
}

export function usePresenting({
  sync,
  elements,
  selectedId,
  setSelectedId,
  canvasSize,
  changeViewport,
}: PresentingOptions) {
  // Our pointer is a laser for the others, who follow our view (see Presenter, useFollow).
  const [slide, setSlide] = useState<number | null>(null);
  const slides = useMemo(() => slideFrames(elements), [elements]);
  const presenting = slide !== null;
  const shownFrame = presenting ? slides[Math.min(slide, slides.length - 1)] : undefined;
  const { present, sendCursor } = sync;
  const startPresenting = () => {
    setSelectedId(null);
    setSlide(
      Math.max(
        0,
        slides.findIndex((frame) => frame.id === selectedId),
      ),
    );
    present(true);
  };
  const stopPresenting = useCallback(() => {
    setSlide(null);
    present(false);
    sendCursor(null); // or the others keep seeing the laser until our pointer moves again
  }, [present, sendCursor]);
  const sendLaser = useCallback((point: XY | null) => sendCursor(point, true), [sendCursor]);
  // Refits when the window goes full screen or the frame changes.
  useEffect(() => {
    if (shownFrame && canvasSize.width)
      changeViewport(fitViewport(getBounds(shownFrame), canvasSize, { padding: 24, maxZoom: MAX_ZOOM }));
  }, [shownFrame, canvasSize, changeViewport]);
  useEffect(() => {
    // eslint-disable-next-line react-hooks/set-state-in-effect -- stopPresenting also tells the socket
    if (presenting && slides.length === 0) stopPresenting(); // every frame was deleted meanwhile
  }, [presenting, slides.length, stopPresenting]);

  return { slides, presenting, shownFrame, setSlide, startPresenting, stopPresenting, sendLaser };
}

export type Presenting = ReturnType<typeof usePresenting>;
