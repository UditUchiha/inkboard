import { useEffect, useLayoutEffect, useRef, useState, useSyncExternalStore } from "react";
import { useElementSize } from "../../lib/useElementSize";
import { useTheme } from "../../providers/ThemeProvider";
import {
  attachEnd,
  connectionAt,
  dotBeatsHandle,
  dotGrab,
  dotHover,
  drawnElement,
  isConnector,
  readyToMove,
  resolveConnectors,
} from "./connectors";
import { ERASER_RADIUS, GRID_SIZE, HIT_TOLERANCE, STROKE_SPLIT_POINTS } from "./constants";
import {
  createElement,
  createNote,
  elementAt,
  frameContents,
  hitTest,
  isDegenerate,
  isFrame,
  newId,
  nextFrameName,
  translate,
  withContents,
} from "./elements";
import {
  appendPoints,
  constrainEnd,
  hasDragged,
  pinchViewport,
  pressRole,
  stalePointers,
  toWorld,
  zoomAround,
} from "./geometry";
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

// What to show for connecting: the shape a connector end being drawn would
// attach to (`outline`), and the shape whose connection dots to show (`dots`: { id, side }).
const NO_HINT = { outline: null, dots: null };
const sameHint = (a, b) =>
  a.outline === b.outline && a.dots?.id === b.dots?.id && (a.dots?.side ?? null) === (b.dots?.side ?? null);
const ARROW_TOOLS = new Set(["arrow", "line"]);

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
  const [hint, setHint] = useState(NO_HINT); // see NO_HINT
  const gesture = useRef(null);
  const pointers = useRef(new Map());

  // Pointer handlers read the latest props from here instead of re-binding.
  const latest = useRef(null);
  latest.current = { tool, style, viewport, spacePressed, editingId, hovering, selectedId, handle, finishGesture };

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
      connectTargetId: hint.outline,
      dots: hint.dots,
    });
  }, [elements, viewport, size, selectedId, editingId, fontsReady, picturesLoaded, theme, hint]);

  const showHint = (next) => setHint((current) => (sameHint(current, next) ? current : next));

  // Dots shown for a tool that's been put away would only get in the way.
  useEffect(() => {
    setHint(NO_HINT);
  }, [tool]);

  // What's under a point, frame names included (they're sized on screen).
  const pick = (world, vp) =>
    elementAt(store.getElements(), world.x, world.y, HIT_TOLERANCE / vp.zoom, { labelScale: 1 / vp.zoom });

  // What a connector end at `world` would attach to (never `except`, the other end's): { target, side },
  // see connectionAt.
  const connectionUnder = (world, vp, except) =>
    connectionAt(store.getElements(), world, { zoom: vp.zoom, tolerance: HIT_TOLERANCE / vp.zoom, except });

  // The same, shown while a connector end is drawn or dragged.
  function connectAt(world, vp, except) {
    const found = connectionUnder(world, vp, except);
    const id = found.target?.id ?? null;
    showHint({ outline: id, dots: id && { id, side: found.side } });
    return found;
  }

  // What the select tool looks for under `world`: the connection there and what's picked (see connectionAt,
  // pick). A pointer move needs both several times over, so they're looked up once and passed along.
  const lookUnder = (world, vp) => ({ found: connectionUnder(world, vp), hit: pick(world, vp) });

  // The shape and side a press at `world` would start an arrow from with the select tool (see dotGrab).
  const dotUnder = (world, vp, under) =>
    dotGrab(store.getElements(), world, { zoom: vp.zoom, tolerance: HIT_TOLERANCE / vp.zoom, ...under });

  // What a select-tool press at `world` goes to, of a handle of the selected element and a connection dot:
  // { selected (as drawn), handle, grab (see dotGrab) }, at most one of handle and grab set (see
  // dotBeatsHandle). The selected shape has its own handles where its dots would be.
  function selectPress(world, vp, under) {
    const selected = drawnSelected();
    const handle = selected ? handleAt(selected, world, vp.zoom) : null;
    let grab = dotUnder(world, vp, under);
    if (grab?.target.id === latest.current.selectedId) grab = null;
    if (dotBeatsHandle(selected, handle, grab, world, vp.zoom)) return { selected, handle: null, grab };
    return { selected, handle, grab: handle ? null : grab };
  }

  // Connection dots on the shape under the pointer (or out on its dots), for the select tool and the tools
  // that make connectors. The selected shape has its own handles there instead.
  function hoverDots(world, vp, under) {
    const { tool: activeTool, selectedId: selection } = latest.current;
    let found = null;
    const options = { zoom: vp.zoom, tolerance: HIT_TOLERANCE / vp.zoom, ...under };
    if (activeTool === "select") found = dotHover(store.getElements(), world, options);
    else if (ARROW_TOOLS.has(activeTool)) found = connectionUnder(world, vp);
    const id = found?.target?.id;
    if (!id || (activeTool === "select" && id === selection)) showHint(NO_HINT);
    else showHint({ outline: null, dots: { id, side: found.side } });
  }

  // Starts drawing `element`. A pen stroke is made at once, as a dot; anything else only when
  // the pointer has really gone somewhere (see hasDragged), so a click leaves nothing behind.
  function startDraw(element, screen, extra) {
    const pen = element.type === "pen";
    gesture.current = { kind: "draw", element, startScreen: screen, created: pen, done: [], ...extra };
    onSelect(null);
    if (pen) store.apply({ upsert: [element] });
  }

  // A connector drawn from `world`: attached to the shape there, and pinned to its side if it's on a dot.
  function startConnector(type, world, screen, vp, style, { select = false } = {}) {
    const { target, side } = connectAt(world, vp);
    startDraw(attachEnd(createElement(type, world, style), "start", target, side), screen, { select });
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
    const added = (samples.length ? samples : [event]).map((sample) => {
      const s = screenPoint(sample);
      const point = toWorld(vp, s.x, s.y);
      return [point.x, point.y, element.pressure ? sample.pressure : 0.5];
    });
    const points = appendPoints(element.points, added);
    return points === element.points ? element : { ...element, points };
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
    // A pinch or Ctrl + wheel over a toolbar, panel or pin on the board's page mustn't zoom the browser page
    // either: it zooms the board instead. On the board's own element rather than the window, and plain
    // wheels are left alone, so scrolling a side panel isn't held up waiting for this.
    const page = containerRef.current?.parentElement ?? canvas;
    const onPageWheel = (event) => {
      if ((!event.ctrlKey && !event.metaKey) || canvas.contains(event.target)) return;
      onWheel(event);
    };
    canvas.addEventListener("wheel", onWheel, { passive: false });
    page.addEventListener("wheel", onPageWheel, { passive: false });
    return () => {
      canvas.removeEventListener("wheel", onWheel);
      page.removeEventListener("wheel", onPageWheel);
    };
  }, [onViewportChange]);

  // The board zooms itself, so a pinch anywhere on its page (over the toolbar or a panel as well) mustn't zoom
  // the browser page: touch-action does that for fingers (see .board-page in index.css), and Safari's own
  // pinch gestures are cancelled here. A Mac trackpad pinch (gesture events where there's no touch screen)
  // zooms the board instead, about the pointer. Only on this page: the others can still be zoomed.
  useEffect(() => {
    const canvas = canvasRef.current;
    const root = document.documentElement;
    root.classList.add("board-page");
    const trackpad = navigator.maxTouchPoints === 0;
    let startZoom = null;
    const onGestureStart = (event) => {
      event.preventDefault();
      startZoom = trackpad && canvas.contains(event.target) ? latest.current.viewport.zoom : null;
    };
    const onGestureChange = (event) => {
      event.preventDefault();
      if (startZoom === null) return;
      const rect = canvas.getBoundingClientRect();
      const zoom = startZoom * event.scale;
      onViewportChange((vp) => zoomAround(vp, zoom, event.clientX - rect.left, event.clientY - rect.top));
    };
    const onGestureEnd = (event) => event.preventDefault();
    document.addEventListener("gesturestart", onGestureStart, { passive: false });
    document.addEventListener("gesturechange", onGestureChange, { passive: false });
    document.addEventListener("gestureend", onGestureEnd, { passive: false });
    return () => {
      root.classList.remove("board-page");
      document.removeEventListener("gesturestart", onGestureStart);
      document.removeEventListener("gesturechange", onGestureChange);
      document.removeEventListener("gestureend", onGestureEnd);
    };
  }, [onViewportChange]);

  // Escape puts away a shape, move, resize or erase in progress, as if it hadn't been started.
  useEffect(() => {
    const onKeyDown = (event) => {
      const kind = gesture.current?.kind;
      if (event.key !== "Escape" || !kind || kind === "pan" || kind === "pinch") return;
      event.stopPropagation(); // the editor's own Escape (deselecting) isn't wanted as well
      latest.current.finishGesture({ cancelled: true });
    };
    window.addEventListener("keydown", onKeyDown, true);
    return () => window.removeEventListener("keydown", onKeyDown, true);
  }, []);

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
    // A frame goes with what's in it, as when it's deleted.
    for (const id of [...hits.keys()]) {
      const frame = store.getElement(id);
      if (!frame || !isFrame(frame)) continue;
      for (const inside of frameContents(store.getElements(), frame)) {
        if (!hits.has(inside.id)) hits.set(inside.id, g.released.get(inside.id) ?? inside);
      }
    }
    for (const [id, element] of hits) g.erased.set(id, element);
    // Connectors attached to what's erased stay where they're drawn (the store lets go of them).
    const released = store.apply({ remove: [...hits.keys()] });
    for (const { before, after } of released) {
      if (!g.released.has(before.id)) g.released.set(before.id, before);
      g.letGo.set(before.id, after);
    }
  }

  // Finishes the current gesture and records it in the undo history, or, if
  // `cancelled`, puts back what it changed. What someone else has removed
  // meanwhile is left removed.
  function finishGesture({ cancelled = false } = {}) {
    const g = gesture.current;
    gesture.current = null;
    setPanning(false);
    if (!g) return;

    setHint(NO_HINT);
    const live = (element) => Boolean(store.getElement(element.id));
    if (g.kind === "draw" && g.created) {
      const strokes = [...g.done, g.element].filter(live); // a long stroke is made of several
      const ids = strokes.map((element) => element.id);
      if (cancelled || isDegenerate(g.element, latest.current.viewport.zoom)) store.apply({ remove: ids });
      else if (strokes.length > 0) {
        store.record({ undo: { remove: ids }, redo: { upsert: strokes } });
        if (g.element.type === "frame") onFrameDrawn?.(g.element.id);
        if (g.select) onSelect(g.element.id);
      }
    } else if (g.kind === "erase" && g.erased.size > 0) {
      const released = [...g.released.keys()].filter((id) => !g.erased.has(id));
      const undo = { upsert: [...g.erased.values(), ...released.map((id) => g.released.get(id))] };
      const letGo = released.map((id) => g.letGo.get(id)); // what the connectors were let go into
      if (cancelled) store.apply(undo, { base: letGo });
      else store.record({ undo, redo: { remove: [...g.erased.keys()] }, undoBase: letGo });
    } else if (g.kind === "move" && g.current) {
      const current = g.current.filter(live);
      const originals = g.originals.filter((element) => current.some(({ id }) => id === element.id));
      if (cancelled) store.apply({ upsert: originals }, { base: current });
      else if (current.length > 0) store.record({ undo: { upsert: originals }, redo: { upsert: current } });
    } else if (g.kind === "transform" && g.current && live(g.current)) {
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
    // A pointer held by this one's id, or another mouse or pen, was let go of without its pointerup reaching
    // the canvas: what it was doing ends as that would have ended it, so it can't hold the canvas up for good.
    for (const id of stalePointers(pointers.current, event.pointerId, event.pointerType, event.timeStamp))
      releasePointer(id);
    // One pointer draws and a second finger turns that into a pinch. A pen landing beside a resting palm
    // takes over from it. Anything else (a palm resting beside a pen, a mouse click while touching, a third
    // finger) is left alone (see pressRole).
    const others = [...pointers.current.values()];
    const role = pressRole(others, event.pointerType);
    if (role === "ignore") return;
    const { viewport: vp, editingId: editing } = latest.current;
    const screen = screenPoint(event);
    canvasRef.current.setPointerCapture(event.pointerId);
    pointers.current.set(event.pointerId, { screen, type: event.pointerType, at: event.timeStamp });

    // The click is on the board now: a title, frame name or color field that had focus lets go of it
    // (and so saves), or keys meant for the board would still go to it.
    const focused = document.activeElement;
    if (focused instanceof HTMLElement && focused !== document.body) focused.blur();

    if (role === "pinch") {
      finishGesture({ cancelled: true });
      const [a, b] = [others[0].screen, screen];
      gesture.current = { kind: "pinch", startDistance: distance(a, b), startMid: midpoint(a, b), startViewport: vp };
      return;
    }
    // What the palm began (a stroke, a move, a pinch) is put back as if it hadn't been, undo history and all.
    if (role === "take over") finishGesture({ cancelled: true });
    // Clicking away from the text being edited saves it, and does no more.
    if (editing) return;

    beginGesture(event, screen);
    if (gesture.current) gesture.current.pointerId = event.pointerId;
  }

  function beginGesture(event, screen) {
    const { tool: activeTool, style: activeStyle, viewport: vp, spacePressed: space } = latest.current;
    const world = toWorld(vp, screen.x, screen.y);
    const tolerance = HIT_TOLERANCE / vp.zoom;

    if (event.button === 1 || space || activeTool === "hand") {
      startPan(screen);
      return;
    }

    switch (activeTool) {
      case "select": {
        // A handle on the selected element takes priority over whatever is underneath it, bar a connection
        // dot beside a line's end (see selectPress).
        const { selected, handle: grabbed, grab } = selectPress(world, vp);
        if (grabbed) {
          const pad = getSelectionBox(selected, vp.zoom).pad ?? 0;
          // Nothing changes until the pointer has been dragged (see the transform case).
          gesture.current = {
            kind: "transform",
            handle: grabbed,
            startScreen: screen,
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
        // Dragging from a shape's connection dot draws an arrow out of that side, even with another arrow
        // already pinned there (see dotGrab).
        if (grab) {
          startConnector("arrow", world, screen, vp, activeStyle, { select: true });
          return;
        }
        const hit = pick(world, vp);
        onSelect(hit?.id ?? null);
        // Nothing moves until the pointer has been dragged (see the move case).
        if (hit) gesture.current = { kind: "move", startScreen: screen, start: world, id: hit.id, current: null };
        else startPan(screen);
        return;
      }
      case "eraser":
        gesture.current = { kind: "erase", erased: new Map(), released: new Map(), letGo: new Map(), last: world };
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
      case "arrow":
      case "line":
        startConnector(activeTool, world, screen, vp, activeStyle);
        return;
      default: {
        const pressure = event.pointerType === "pen" ? event.pressure : undefined;
        const element = createElement(activeTool, world, activeStyle, pressure);
        if (element.type === "frame") element.name = nextFrameName(store.getElements());
        startDraw(element, screen);
      }
    }
  }

  function handlePointerMove(event) {
    const g = gesture.current;
    // Seen alive, even when it isn't the one carrying a gesture (see stalePointers).
    const tracked = pointers.current.get(event.pointerId);
    if (tracked) tracked.at = event.timeStamp;
    // Only the pointer that began a gesture carries it on (a palm or another finger doesn't).
    if (g && g.kind !== "pinch" && event.pointerId !== g.pointerId) return;
    const screen = screenPoint(event);
    if (tracked) tracked.screen = screen;
    const vp = latest.current.viewport;
    const world = toWorld(vp, screen.x, screen.y);
    onCursorMove(world);

    if (!g) {
      let overHandle = null;
      // One look under the pointer for all of it, not a scan of the board for each (see lookUnder).
      const under = latest.current.tool === "select" ? lookUnder(world, vp) : undefined;
      if (under) {
        overHandle = selectPress(world, vp, under).handle;
        if (overHandle !== latest.current.handle) setHandle(overHandle);
        const over = !overHandle && Boolean(under.hit);
        if (over !== latest.current.hovering) setHovering(over);
      }
      if (overHandle) showHint(NO_HINT);
      else hoverDots(world, vp, under);
      return;
    }

    switch (g.kind) {
      case "pinch": {
        if (pointers.current.size < 2) return;
        const [a, b] = [...pointers.current.values()].map((pointer) => pointer.screen);
        onViewportChange(pinchViewport(g.startViewport, g.startMid, g.startDistance, a, b));
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
        if (!g.created) {
          if (!hasDragged(g.startScreen, screen)) return;
          g.created = true;
          store.apply({ upsert: [g.element] });
        } else if (!store.getElement(g.element.id)) {
          finishGesture({ cancelled: true }); // someone removed it
          return;
        }
        let next =
          g.element.type === "pen" ? extendStroke(g.element, event, vp) : resizeShape(g.element, world, event.shiftKey);
        if (isConnector(next)) {
          const { target, side } = connectAt(world, vp, next.startId);
          next = attachEnd(next, "end", target, side);
        }
        // Made from the step before, so a color someone picks mid-draw isn't painted over.
        store.apply({ upsert: [next] }, { base: [g.element] });
        g.element = next;
        if (next.type === "pen" && next.points.length >= STROKE_SPLIT_POINTS) {
          // Carry on as a new stroke from where this one ends.
          g.done.push(next);
          g.element = { ...next, id: newId(), points: [next.points.at(-1)] };
          store.apply({ upsert: [g.element] });
        }
        return;
      }
      case "erase":
        eraseAlong(g.last, world);
        g.last = world;
        return;
      case "move": {
        if (!g.originals) {
          if (!hasDragged(g.startScreen, screen)) return;
          // The drag has begun: a frame takes what's inside it along, and connectors let go of shapes left behind.
          const grabbed = store.getElement(g.id);
          if (!grabbed) {
            finishGesture({ cancelled: true });
            return;
          }
          g.originals = withContents(store.getElements(), grabbed);
          g.ready = readyToMove(store.getElements(), g.originals);
        }
        // Whatever someone removes mid-drag stays removed.
        const moved = g.ready
          .filter((element) => store.getElement(element.id))
          .map((element) => translate(element, world.x - g.start.x, world.y - g.start.y));
        if (moved.length === 0) {
          finishGesture({ cancelled: true });
          return;
        }
        // Each step is made from the one before, so only what the drag changes is sent.
        store.apply({ upsert: moved }, { base: g.current ?? g.originals });
        g.current = moved;
        return;
      }
      case "transform": {
        // A click on a handle with a shaky hand doesn't turn or resize anything (or add an undo step).
        if (!g.current && !hasDragged(g.startScreen, screen)) return;
        if (!store.getElement(g.original.id)) {
          finishGesture({ cancelled: true }); // someone removed it
          return;
        }
        let next =
          g.handle === "rotate"
            ? rotateElement(g.from, g.start, world, { snap: event.shiftKey })
            : resizeElement(g.from, g.handle, world, { keepAspect: event.shiftKey, pad: g.pad });
        // A connector's end attaches to whatever it's dropped on, and lets go elsewhere.
        if (g.handle === "start" || g.handle === "end") {
          const other = g.handle === "start" ? next.endId : next.startId;
          const { target, side } = connectAt(world, vp, other);
          next = attachEnd(next, g.handle, target, side);
        }
        store.apply({ upsert: [next] }, { base: [g.current ?? g.original] });
        g.current = next;
        return;
      }
      default:
    }
  }

  // Lets go of a pointer, ending what it was doing: done, or put back if `cancelled`.
  function releasePointer(pointerId, { cancelled = false } = {}) {
    if (!pointers.current.delete(pointerId)) return; // not one that was taken in (see handlePointerDown)
    const g = gesture.current;
    if (g?.kind === "pinch") {
      if (pointers.current.size === 0) gesture.current = null;
      return;
    }
    if (g && pointerId !== g.pointerId) return;
    finishGesture({ cancelled });
  }

  const handlePointerUp = (event) => releasePointer(event.pointerId, { cancelled: event.type === "pointercancel" });

  // Capture lost without a pointerup (the window lost focus, a context menu opened) ends the gesture as a
  // pointercancel does. After a pointerup it comes too, and finds the pointer already let go of.
  const handleLostCapture = (event) => releasePointer(event.pointerId, { cancelled: true });

  function handleDoubleClick(event) {
    if (latest.current.tool !== "select") return;
    const vp = latest.current.viewport;
    const screen = screenPoint(event);
    const world = toWorld(vp, screen.x, screen.y);
    const hit = pick(world, vp);
    if (hit?.type === "text" || hit?.type === "sticky") onEditText({ element: hit, isNew: false });
    // A line's or arrow's label is typed where it's drawn, halfway along.
    else if (hit && isConnector(hit)) onEditText({ element: store.getElement(hit.id), isNew: false });
  }

  let cursor = "crosshair";
  if (panning) cursor = "grabbing";
  else if (spacePressed || tool === "hand") cursor = "grab";
  else if (tool === "select" && handle) {
    const selected = selectedId ? store.getElement(selectedId) : null;
    cursor = turning ? "grabbing" : cursorForHandle(handle, selected?.angle ?? 0);
  } else if (tool === "select" && hint.dots?.side) cursor = "crosshair";
  else if (tool === "select") cursor = hovering ? "move" : "default";
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
        onLostPointerCapture={handleLostCapture}
        onPointerLeave={() => {
          onCursorMove(null);
          if (!gesture.current) setHint(NO_HINT);
        }}
        onMouseDown={(event) => event.preventDefault()}
        onDoubleClick={handleDoubleClick}
        aria-label="Drawing canvas"
      />
    </div>
  );
}
