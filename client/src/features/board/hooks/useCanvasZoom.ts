import { useEffect } from "react";
import type { RefObject } from "react";
import { zoomAround } from "../lib/elements/geometry";
import type { Viewport } from "../lib/elements/geometry";

// Safari's pinch gesture events, which the DOM's types lack.
type PinchEvent = Event & { scale: number; clientX: number; clientY: number };

export function useCanvasZoom(
  canvasRef: RefObject<HTMLCanvasElement | null>,
  containerRef: RefObject<HTMLDivElement | null>,
  latest: RefObject<{ viewport: Viewport }>,
  onViewportChange: (next: Viewport | ((current: Viewport) => Viewport)) => void,
) {
  // Trackpad pinch and Ctrl/Cmd + wheel zoom; plain wheel scrolls the board.
  useEffect(() => {
    const canvas = canvasRef.current!;
    const onWheel = (event: WheelEvent) => {
      event.preventDefault();
      const rect = canvas.getBoundingClientRect();
      const sx = event.clientX - rect.left;
      const sy = event.clientY - rect.top;
      const unit = event.deltaMode === 1 ? 16 : 1;
      if (event.ctrlKey || event.metaKey) {
        const factor = Math.exp(-event.deltaY * unit * 0.0025);
        onViewportChange((vp) => zoomAround(vp, vp.zoom * factor, sx, sy));
      } else {
        const horizontal = event.shiftKey && !event.deltaX;
        const dx = (horizontal ? event.deltaY : event.deltaX) * unit;
        const dy = (horizontal ? 0 : event.deltaY) * unit;
        onViewportChange((vp) => ({ ...vp, x: vp.x - dx / vp.zoom, y: vp.y - dy / vp.zoom }));
      }
    };
    // Pinch or Ctrl + wheel over a panel must zoom the board, not the browser page. Bound on the board's element,
    // not the window, and plain wheels are left alone so side panels still scroll.
    const page = containerRef.current?.parentElement ?? canvas;
    const onPageWheel = (event: WheelEvent) => {
      // The cast: a wheel event on the page is aimed at a node.
      if ((!event.ctrlKey && !event.metaKey) || canvas.contains(event.target as Node)) return;
      onWheel(event);
    };
    canvas.addEventListener("wheel", onWheel, { passive: false });
    page.addEventListener("wheel", onPageWheel, { passive: false });
    return () => {
      canvas.removeEventListener("wheel", onWheel);
      page.removeEventListener("wheel", onPageWheel);
    };
  }, [canvasRef, containerRef, onViewportChange]);

  // touch-action stops browser pinch for fingers (see .board-page in index.css); Safari's gesture events are cancelled
  // here, and a Mac trackpad pinch zooms the board about the pointer. Only on this page: the others stay zoomable.
  useEffect(() => {
    const canvas = canvasRef.current!;
    const root = document.documentElement;
    root.classList.add("board-page");
    const trackpad = navigator.maxTouchPoints === 0;
    let startZoom: number | null = null;
    const onGestureStart = (event: Event) => {
      event.preventDefault();
      // The cast: a gesture event is aimed at a node.
      startZoom = trackpad && canvas.contains(event.target as Node) ? latest.current.viewport.zoom : null;
    };
    // The cast: addEventListener takes a listener of plain events, and this one is of Safari's.
    const onGestureChange = ((event: PinchEvent) => {
      event.preventDefault();
      if (startZoom === null) return;
      const rect = canvas.getBoundingClientRect();
      const zoom = startZoom * event.scale;
      onViewportChange((vp) => zoomAround(vp, zoom, event.clientX - rect.left, event.clientY - rect.top));
    }) as EventListener;
    const onGestureEnd = (event: Event) => event.preventDefault();
    document.addEventListener("gesturestart", onGestureStart, { passive: false });
    document.addEventListener("gesturechange", onGestureChange, { passive: false });
    document.addEventListener("gestureend", onGestureEnd, { passive: false });
    return () => {
      root.classList.remove("board-page");
      document.removeEventListener("gesturestart", onGestureStart);
      document.removeEventListener("gesturechange", onGestureChange);
      document.removeEventListener("gestureend", onGestureEnd);
    };
  }, [canvasRef, latest, onViewportChange]);
}
