import { useEffect, useLayoutEffect, useRef, useState, useSyncExternalStore } from "react";
import { useElementSize } from "../../lib/useElementSize";
import { useTheme } from "../../providers/ThemeProvider";
import {
  attachEnd,
  connectTargetAt,
  drawnElement,
  isConnector,
  readyToMove,
  releaseFrom,
  resolveConnectors,
} from "./connectors";
import { ERASER_RADIUS, GRID_SIZE, HIT_TOLERANCE, MAX_ZOOM, MIN_ZOOM } from "./constants";
import {
  createElement,
  createNote,
  elementAt,
  hitTest,
  isDegenerate,
  nextFrameName,
  translate,
  withContents,
} from "./elements";
import { clamp, constrainEnd, toWorld, zoomAround } from "./geometry";
import { imagesVersion, subscribeImages } from "./images";
import { loadCanvasFonts, renderScene } from "./renderer";
import { useBoardSnapshot } from "./store";
import { cursorForHandle, getSelectionBox, handleAt, resizeElement, rotateElement } from "./transform";

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
  onPlaceComment,
  onFrameDrawn,
}) {
  const containerRef = useRef(null);
  const canvasRef = useRef(null);
  const size = useElementSize(containerRef);
  const fontsReady = useCanvasFontsReady();
  const picturesLoaded = useSyncExternalStore(subscribeImages, imagesVersion);
  const { theme } = useTheme();
  const { elements } = useBoardSnapshot(store);

  const [panning, setPanning] = useState(false);
  const [hovering, setHovering] = useState(false);
  const [handle, setHandle] = useState(null); // the resize or turn handle under the pointer, or being dragged
  const [turning, setTurning] = useState(false);
  const [connectTarget, setConnectTarget] = useState(null); // the shape a connector end being drawn would attach to
  const gesture = useRef(null);
  const pointers = useRef(new Map());

  // Pointer handlers read the latest props from here instead of re-binding.
  const latest = useRef(null);
  latest.current = { tool, style, viewport, spacePressed, editingId, hovering, selectedId, handle };

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
    renderScene(canvas, {
      elements,
      viewport,
      dpr,
      selectedId,
      hiddenId: editingId,
      dark: theme === "dark",
      screenLabels: true,
      connectTargetId: connectTarget,
    });
  }, [elements, viewport, size, selectedId, editingId, fontsReady, picturesLoaded, theme, connectTarget]);

  // What's under a point, frame names included (they're sized on screen).
  const pick = (world, vp) =>
    elementAt(store.getElements(), world.x, world.y, HIT_TOLERANCE / vp.zoom, { labelScale: 1 / vp.zoom });

  // The shape a connector end at `world` would attach to (never `except`, the other end's), and show it.
  function connectAt(world, vp, except) {
    const target = connectTargetAt(store.getElements(), world, HIT_TOLERANCE / vp.zoom, { except });
    setConnectTarget(target?.id ?? null);
    return target;
  }

  // The selected element as it's drawn (a connector's ends where its shapes are).
  const drawnSelected = () => {
    const id = latest.current.selectedId;
    return id ? drawnElement(store.getElements(), id) : null;
  };

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
    for (const element of resolveConnectors(store.getElements())) {
      for (let i = 0; i <= steps; i += 1) {
        const x = from.x + ((to.x - from.x) * i) / steps;
        const y = from.y + ((to.y - from.y) * i) / steps;
        if (hitTest(element, x, y, radius)) {
          // As it was before this stroke, if the stroke has already let it go of a shape.
          hits.set(element.id, g.released.get(element.id) ?? store.getElement(element.id));
          break;
        }
      }
    }
    if (hits.size === 0) return;
    for (const [id, element] of hits) g.erased.set(id, element);
    // Connectors attached to what's erased stay where they're drawn.
    const released = releaseFrom(store.getElements(), new Set(hits.keys()));
    for (const { before } of released) if (!g.released.has(before.id)) g.released.set(before.id, before);
    store.apply({ remove: [...hits.keys()], upsert: released.map(({ after }) => after) });
  }

  // Finishes the current gesture and records it in the undo history.
  function finishGesture({ cancelled = false } = {}) {
    const g = gesture.current;
    gesture.current = null;
    setPanning(false);
    if (!g) return;

    setConnectTarget(null);
    if (g.kind === "draw") {
      if (cancelled || isDegenerate(g.element)) store.apply({ remove: [g.element.id] });
      else {
        store.record({ undo: { remove: [g.element.id] }, redo: { upsert: [g.element] } });
        if (g.element.type === "frame") onFrameDrawn?.(g.element.id);
      }
    } else if (g.kind === "erase" && g.erased.size > 0) {
      const released = [...g.released.keys()].filter((id) => !g.erased.has(id));
      store.record({
        undo: { upsert: [...g.erased.values(), ...released.map((id) => g.released.get(id))] },
        redo: {
          remove: [...g.erased.keys()],
          upsert: released.map((id) => store.getElement(id)).filter(Boolean),
        },
      });
    } else if (g.kind === "move" && g.current) {
      if (cancelled) store.apply({ upsert: g.originals }, { base: g.current });
      else store.record({ undo: { upsert: g.originals }, redo: { upsert: g.current } });
    } else if (g.kind === "transform" && g.current) {
      if (cancelled) store.apply({ upsert: [g.original] }, { base: [g.current] });
      else store.record({ undo: { upsert: [g.original] }, redo: { upsert: [g.current] } });
    }
    if (g.kind === "transform") {
      setTurning(false);
      setHandle(null);
    }
  }

  function startPan(screen) {
    gesture.current = { kind: "pan", startScreen: screen, startViewport: latest.current.viewport };
    setPanning(true);
  }

  function handlePointerDown(event) {
    if (event.button !== 0 && event.button !== 1) return;
    const {
      tool: activeTool,
      style: activeStyle,
      viewport: vp,
      spacePressed: space,
      editingId: editing,
    } = latest.current;
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
        // A handle on the selected element takes priority over whatever is underneath it.
        const selected = drawnSelected();
        const grabbed = selected ? handleAt(selected, world, vp.zoom) : null;
        if (grabbed) {
          const pad = getSelectionBox(selected, vp.zoom).pad ?? 0;
          gesture.current = {
            kind: "transform",
            handle: grabbed,
            start: world,
            original: store.getElement(selected.id), // as stored, for undo
            from: selected, // as drawn, to work from
            pad,
            current: null,
          };
          setHandle(grabbed);
          setTurning(grabbed === "rotate");
          return;
        }
        const hit = pick(world, vp);
        onSelect(hit?.id ?? null);
        if (hit) {
          // A frame takes what's inside it along. Connectors let go of shapes left behind.
          const originals = withContents(store.getElements(), store.getElement(hit.id));
          gesture.current = {
            kind: "move",
            start: world,
            originals,
            ready: readyToMove(store.getElements(), originals),
          };
        } else startPan(screen);
        return;
      }
      case "eraser":
        gesture.current = { kind: "erase", erased: new Map(), released: new Map(), last: world };
        eraseAlong(world, world);
        return;
      case "comment":
        onPlaceComment?.(world);
        return;
      case "text": {
        const hit = elementAt(store.getElements(), world.x, world.y, tolerance);
        if (hit?.type === "text") onEditText({ element: hit, isNew: false });
        else onEditText({ element: createElement("text", world, activeStyle), isNew: true });
        return;
      }
      case "sticky": {
        const hit = elementAt(store.getElements(), world.x, world.y, tolerance);
        if (hit?.type === "sticky") onEditText({ element: hit, isNew: false });
        else onEditText({ element: createNote(world, activeStyle), isNew: true });
        return;
      }
      default: {
        const pressure = event.pointerType === "pen" ? event.pressure : undefined;
        let element = createElement(activeTool, world, activeStyle, pressure);
        if (element.type === "frame") element.name = nextFrameName(store.getElements());
        if (isConnector(element)) element = attachEnd(element, "start", connectAt(world, vp));
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
        const selected = drawnSelected();
        const overHandle = selected ? handleAt(selected, world, vp.zoom) : null;
        if (overHandle !== latest.current.handle) setHandle(overHandle);
        const over = !overHandle && Boolean(pick(world, vp));
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
        let next =
          g.element.type === "pen" ? extendStroke(g.element, event, vp) : resizeShape(g.element, world, event.shiftKey);
        if (isConnector(next)) next = attachEnd(next, "end", connectAt(world, vp, next.startId));
        // Made from the step before, so a color someone picks mid-draw isn't painted over.
        store.apply({ upsert: [next] }, { base: [g.element] });
        g.element = next;
        return;
      }
      case "erase":
        eraseAlong(g.last, world);
        g.last = world;
        return;
      case "move": {
        const moved = g.ready.map((element) => translate(element, world.x - g.start.x, world.y - g.start.y));
        // Each step is made from the one before, so only what the drag changes is sent.
        store.apply({ upsert: moved }, { base: g.current ?? g.originals });
        g.current = moved;
        return;
      }
      case "transform": {
        let next =
          g.handle === "rotate"
            ? rotateElement(g.from, g.start, world, { snap: event.shiftKey })
            : resizeElement(g.from, g.handle, world, { keepAspect: event.shiftKey, pad: g.pad });
        // A connector's end attaches to whatever it's dropped on, and lets go elsewhere.
        if (g.handle === "start" || g.handle === "end") {
          const other = g.handle === "start" ? next.endId : next.startId;
          next = attachEnd(next, g.handle, connectAt(world, vp, other));
        }
        store.apply({ upsert: [next] }, { base: [g.current ?? g.original] });
        g.current = next;
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
    const hit = pick(world, vp);
    if (hit?.type === "text" || hit?.type === "sticky") onEditText({ element: hit, isNew: false });
  }

  let cursor = "crosshair";
  if (panning) cursor = "grabbing";
  else if (spacePressed || tool === "hand") cursor = "grab";
  else if (tool === "select" && handle) {
    const selected = selectedId ? store.getElement(selectedId) : null;
    cursor = turning ? "grabbing" : cursorForHandle(handle, selected?.angle ?? 0);
  } else if (tool === "select") cursor = hovering ? "move" : "default";
  else if (tool === "text") cursor = "text";
  else if (tool === "comment") cursor = "copy";
  else if (tool === "eraser") cursor = ERASER_CURSOR;

  return (
    <div ref={containerRef} className="graph-paper absolute inset-0" style={gridStyle(viewport)}>
      <canvas
        ref={canvasRef}
        className="absolute inset-0 h-full w-full touch-none"
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
