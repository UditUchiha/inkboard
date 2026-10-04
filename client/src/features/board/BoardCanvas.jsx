import { useEffect, useLayoutEffect, useRef, useState } from "react";
import { useElementSize } from "../../lib/useElementSize";
import { ERASER_RADIUS, GRID_SIZE, HIT_TOLERANCE, MAX_ZOOM, MIN_ZOOM } from "./constants";
import { createElement, elementAt, hitTest, isDegenerate, translate } from "./elements";
import { clamp, constrainEnd, toWorld, zoomAround } from "./geometry";
import { loadCanvasFonts, renderScene } from "./renderer";
import { useBoardSnapshot } from "./store";

const ERASER_CURSOR = `url("data:image/svg+xml,${encodeURIComponent(
  '<svg xmlns="http://www.w3.org/2000/svg" width="22" height="22"><circle cx="11" cy="11" r="9" fill="white" fill-opacity=".6" stroke="#16213a" stroke-width="1.5"/></svg>',
)}") 11 11, crosshair`;

function useCanvasFontsReady() {
  const [ready, setReady] = useState(false);
  useEffect(() => {
    let active = true;
    loadCanvasFonts().then(() => active && setReady(true));
    return () => {
      active = false;
    };
  }, []);
  return ready;
}

// Grid cells shrink with zoom; jump to the next coarser grid when they get tiny.
function gridStyle(viewport) {
  let cell = GRID_SIZE * viewport.zoom;
  while (cell < 10) cell *= 5;
  return {
    "--cell": `${cell}px`,
    backgroundPosition: `${viewport.x * viewport.zoom}px ${viewport.y * viewport.zoom}px`,
  };
}

const distance = (a, b) => Math.hypot(a.x - b.x, a.y - b.y);
const midpoint = (a, b) => ({ x: (a.x + b.x) / 2, y: (a.y + b.y) / 2 });

export function BoardCanvas({
  store,
  tool,
  style,
  viewport,
  onViewportChange,
  selectedId,
  onSelect,
  editingId,
  onEditText,
  spacePressed,
  onCursorMove,
  onSizeChange,
}) {
  const containerRef = useRef(null);
  const canvasRef = useRef(null);
  const size = useElementSize(containerRef);
  const fontsReady = useCanvasFontsReady();
  const { elements } = useBoardSnapshot(store);

  const [panning, setPanning] = useState(false);
  const [hovering, setHovering] = useState(false);
  const gesture = useRef(null);
  const pointers = useRef(new Map());

  // Pointer handlers read the latest props from here instead of re-binding.
  const latest = useRef(null);
  latest.current = { tool, style, viewport, spacePressed, editingId, hovering };

  useEffect(() => {
    onSizeChange?.(size);
  }, [size, onSizeChange]);

  useLayoutEffect(() => {
    const canvas = canvasRef.current;
    if (!canvas || !size.width) return;
    const dpr = window.devicePixelRatio || 1;
    const width = Math.round(size.width * dpr);
    const height = Math.round(size.height * dpr);
    if (canvas.width !== width) canvas.width = width;
    if (canvas.height !== height) canvas.height = height;
    renderScene(canvas, { elements, viewport, dpr, selectedId, hiddenId: editingId });
  }, [elements, viewport, size, selectedId, editingId, fontsReady]);

  const screenPoint = (event) => {
    const rect = canvasRef.current.getBoundingClientRect();
    return { x: event.clientX - rect.left, y: event.clientY - rect.top };
  };

  // Coalesced events give smoother strokes on high-frequency pens and mice.
  function extendStroke(element, event, vp) {
    const samples = event.getCoalescedEvents?.() ?? [];
    const points = (samples.length ? samples : [event]).map((sample) => {
      const s = screenPoint(sample);
      const point = toWorld(vp, s.x, s.y);
      return [point.x, point.y, element.pressure ? sample.pressure : 0.5];
    });
    return { ...element, points: [...element.points, ...points] };
  }

  function resizeShape(element, world, constrained) {
    const end = constrained
      ? constrainEnd(element.type, element.x1, element.y1, world.x, world.y)
      : { x2: world.x, y2: world.y };
    return { ...element, ...end };
  }

  // Trackpad pinch and Ctrl/Cmd + wheel zoom; plain wheel scrolls the board.
  useEffect(() => {
    const canvas = canvasRef.current;
    const onWheel = (event) => {
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
    canvas.addEventListener("wheel", onWheel, { passive: false });
    return () => canvas.removeEventListener("wheel", onWheel);
  }, [onViewportChange]);

  function eraseAlong(from, to) {
    const g = gesture.current;
    const { zoom } = latest.current.viewport;
    const radius = ERASER_RADIUS / zoom;
    // Sample along the path so fast strokes don't skip over thin lines.
    const steps = Math.max(1, Math.ceil(Math.hypot(to.x - from.x, to.y - from.y) / radius));
    const hits = new Map();
    for (const element of store.getElements()) {
      for (let i = 0; i <= steps; i += 1) {
        const x = from.x + ((to.x - from.x) * i) / steps;
        const y = from.y + ((to.y - from.y) * i) / steps;
        if (hitTest(element, x, y, radius)) {
          hits.set(element.id, element);
          break;
        }
      }
    }
    if (hits.size === 0) return;
    for (const [id, element] of hits) g.erased.set(id, element);
    store.apply({ remove: [...hits.keys()] });
  }

  // Finishes the current gesture and records it in the undo history.
  function finishGesture({ cancelled = false } = {}) {
    const g = gesture.current;
    gesture.current = null;
    setPanning(false);
    if (!g) return;

    if (g.kind === "draw") {
      if (cancelled || isDegenerate(g.element)) store.apply({ remove: [g.element.id] });
      else store.record({ undo: { remove: [g.element.id] }, redo: { upsert: [g.element] } });
    } else if (g.kind === "erase" && g.erased.size > 0) {
      store.record({ undo: { upsert: [...g.erased.values()] }, redo: { remove: [...g.erased.keys()] } });
    } else if (g.kind === "move" && g.current) {
      if (cancelled) store.apply({ upsert: [g.original] });
      else store.record({ undo: { upsert: [g.original] }, redo: { upsert: [g.current] } });
    }
  }

  function startPan(screen) {
    gesture.current = { kind: "pan", startScreen: screen, startViewport: latest.current.viewport };
    setPanning(true);
  }

  function handlePointerDown(event) {
    if (event.button !== 0 && event.button !== 1) return;
    const { tool: activeTool, style: activeStyle, viewport: vp, spacePressed: space, editingId: editing } = latest.current;
    const screen = screenPoint(event);
    canvasRef.current.setPointerCapture(event.pointerId);
    pointers.current.set(event.pointerId, screen);

    // A second finger turns any gesture into pinch-zoom.
    if (pointers.current.size === 2) {
      finishGesture({ cancelled: true });
      const [a, b] = [...pointers.current.values()];
      gesture.current = { kind: "pinch", startDistance: distance(a, b), startMid: midpoint(a, b), startViewport: vp };
      return;
    }
    if (pointers.current.size > 2) return;

    if (editing) {
      // Clicking away from the text being edited saves it.
      document.activeElement?.blur();
      return;
    }

    const world = toWorld(vp, screen.x, screen.y);
    const tolerance = HIT_TOLERANCE / vp.zoom;

    if (event.button === 1 || space || activeTool === "hand") {
      startPan(screen);
      return;
    }

    switch (activeTool) {
      case "select": {
        const hit = elementAt(store.getElements(), world.x, world.y, tolerance);
        onSelect(hit?.id ?? null);
        if (hit) gesture.current = { kind: "move", start: world, original: hit, current: null };
        else startPan(screen);
        return;
      }
      case "eraser":
        gesture.current = { kind: "erase", erased: new Map(), last: world };
        eraseAlong(world, world);
        return;
      case "text": {
        const hit = elementAt(store.getElements(), world.x, world.y, tolerance);
        if (hit?.type === "text") onEditText({ element: hit, isNew: false });
        else onEditText({ element: createElement("text", world, activeStyle), isNew: true });
        return;
      }
      default: {
        const pressure = event.pointerType === "pen" ? event.pressure : undefined;
        const element = createElement(activeTool, world, activeStyle, pressure);
        gesture.current = { kind: "draw", element };
        onSelect(null);
        store.apply({ upsert: [element] });
      }
    }
  }

  function handlePointerMove(event) {
    const screen = screenPoint(event);
    if (pointers.current.has(event.pointerId)) pointers.current.set(event.pointerId, screen);
    const vp = latest.current.viewport;
    const world = toWorld(vp, screen.x, screen.y);
    onCursorMove(world);

    const g = gesture.current;
    if (!g) {
      if (latest.current.tool === "select") {
        const over = Boolean(elementAt(store.getElements(), world.x, world.y, HIT_TOLERANCE / vp.zoom));
        if (over !== latest.current.hovering) setHovering(over);
      }
      return;
    }

    switch (g.kind) {
      case "pinch": {
        if (pointers.current.size < 2) return;
        const [a, b] = [...pointers.current.values()];
        const start = g.startViewport;
        const zoom = clamp((start.zoom * distance(a, b)) / g.startDistance, MIN_ZOOM, MAX_ZOOM);
        const anchor = toWorld(start, g.startMid.x, g.startMid.y);
        const mid = midpoint(a, b);
        onViewportChange({ zoom, x: mid.x / zoom - anchor.x, y: mid.y / zoom - anchor.y });
        return;
      }
      case "pan": {
        const start = g.startViewport;
        onViewportChange({
          ...start,
          x: start.x + (screen.x - g.startScreen.x) / start.zoom,
          y: start.y + (screen.y - g.startScreen.y) / start.zoom,
        });
        return;
      }
      case "draw": {
        const next = g.element.type === "pen" ? extendStroke(g.element, event, vp) : resizeShape(g.element, world, event.shiftKey);
        g.element = next;
        store.apply({ upsert: [next] });
        return;
      }
      case "erase":
        eraseAlong(g.last, world);
        g.last = world;
        return;
      case "move": {
        const moved = translate(g.original, world.x - g.start.x, world.y - g.start.y);
        g.current = moved;
        store.apply({ upsert: [moved] });
        return;
      }
      default:
    }
  }

  function handlePointerUp(event) {
    pointers.current.delete(event.pointerId);
    if (gesture.current?.kind === "pinch") {
      if (pointers.current.size === 0) gesture.current = null;
      return;
    }
    finishGesture({ cancelled: event.type === "pointercancel" });
  }

  function handleDoubleClick(event) {
    if (latest.current.tool !== "select") return;
    const vp = latest.current.viewport;
    const screen = screenPoint(event);
    const world = toWorld(vp, screen.x, screen.y);
    const hit = elementAt(store.getElements(), world.x, world.y, HIT_TOLERANCE / vp.zoom);
    if (hit?.type === "text") onEditText({ element: hit, isNew: false });
  }

  let cursor = "crosshair";
  if (panning) cursor = "grabbing";
  else if (spacePressed || tool === "hand") cursor = "grab";
  else if (tool === "select") cursor = hovering ? "move" : "default";
  else if (tool === "text") cursor = "text";
  else if (tool === "eraser") cursor = ERASER_CURSOR;

  return (
    <div ref={containerRef} className="graph-paper absolute inset-0" style={gridStyle(viewport)}>
      <canvas
        ref={canvasRef}
        className="canvas-ink absolute inset-0 h-full w-full touch-none"
        style={{ cursor }}
        onPointerDown={handlePointerDown}
        onPointerMove={handlePointerMove}
        onPointerUp={handlePointerUp}
        onPointerCancel={handlePointerUp}
        onPointerLeave={() => onCursorMove(null)}
        onMouseDown={(event) => event.preventDefault()}
        onDoubleClick={handleDoubleClick}
        aria-label="Drawing canvas"
      />
    </div>
  );
}
