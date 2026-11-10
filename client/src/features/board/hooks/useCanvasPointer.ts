import type { Element as BoardElement, PenElement, Point, StickyElement } from "@inkboard/shared/types";
import { useEffect, useRef, useState } from "react";
import type { MouseEvent, PointerEvent, RefObject } from "react";
import { STROKE_SPLIT_POINTS } from "../constants/board";
import type { Style, ToolId } from "../constants/board";
import type { TextEdit } from "../constants/editor";
import { HIT_TOLERANCE } from "../constants/board";
import { attachEnd, isConnector, readyToMove } from "../lib/elements/connectors";
import type { Connector } from "../lib/elements/elements";
import {
  canChange,
  clampPoint,
  clampShift,
  edgeRoom,
  fitInside,
  pointInside,
  staysInside,
} from "../lib/elements/classroom";
import type { Zone } from "../lib/elements/classroom";
import {
  createElement,
  createNote,
  elementAt,
  newId,
  nextFrameName,
  translate,
  withContents,
} from "../lib/elements/elements";
import {
  appendPoints,
  constrainEnd,
  hasDragged,
  pinchViewport,
  pressRole,
  stalePointers,
  toWorld,
} from "../lib/elements/geometry";
import type { Viewport, XY } from "../lib/elements/geometry";
import { cropImage, getSelectionBox, resizeElement, rotateElement } from "../lib/elements/transform";
import type { BoardStore } from "../lib/sync/store";
import { NO_HINT, useCanvasHints } from "./useCanvasHints";
import { HOLD_MS, useGestureLifecycle } from "./useGestureLifecycle";
import type { DrawGesture, Gesture, Held, Latest } from "./useGestureLifecycle";

const distance = (a: XY, b: XY) => Math.hypot(a.x - b.x, a.y - b.y);
const midpoint = (a: XY, b: XY): XY => ({ x: (a.x + b.x) / 2, y: (a.y + b.y) / 2 });

type Located = { clientX: number; clientY: number };

interface CanvasPointerOptions {
  store: BoardStore;
  canvasRef: RefObject<HTMLCanvasElement | null>;
  tool: ToolId;
  style: Style;
  viewport: Viewport;
  spacePressed: boolean;
  editingId?: string | undefined;
  selectedId: string | null;
  croppingId: string | null;
  zone?: Zone;
  onViewportChange: (next: Viewport | ((current: Viewport) => Viewport)) => void;
  onSelect: (id: string | null) => void;
  onEditText: (edit: TextEdit) => void;
  onCursorMove: (point: XY | null) => void;
  onPlaceComment?: ((point: XY) => void) | undefined;
  onVote?: ((point: XY, hit: BoardElement | null) => void) | undefined;
  onFrameDrawn?: ((id: string) => void) | undefined;
  onOutsideZone?: ((point: XY) => void) | undefined;
}

export function useCanvasPointer({
  store,
  canvasRef,
  tool,
  style,
  viewport,
  spacePressed,
  editingId,
  selectedId,
  croppingId,
  zone,
  onViewportChange,
  onSelect,
  onEditText,
  onCursorMove,
  onPlaceComment,
  onVote,
  onFrameDrawn,
  onOutsideZone,
}: CanvasPointerOptions) {
  const [panning, setPanning] = useState(false);
  const [hovering, setHovering] = useState(false);
  const [handle, setHandle] = useState<string | null>(null);
  const [turning, setTurning] = useState(false);
  const gesture = useRef<Gesture | null>(null);
  const pointers = useRef(new Map<number, Held>());
  // Pointer handlers read the latest props from here instead of re-binding.
  // The assertion: it is set on every render, before any handler can run.
  const latest = useRef<Latest>(null!);

  const { hint, setHint, showHint, pick, connectAt, lookUnder, selectPress, hoverDots } = useCanvasHints(
    store,
    latest,
    tool,
  );
  const { eraseAlong, finishGesture, snapToShape } = useGestureLifecycle({
    store,
    gesture,
    latest,
    setPanning,
    setTurning,
    setHandle,
    setHint,
    onSelect,
    onFrameDrawn,
  });
  latest.current = {
    tool,
    style,
    viewport,
    spacePressed,
    editingId,
    hovering,
    selectedId,
    handle,
    finishGesture,
    zone,
  };

  useEffect(() => {
    const onKeyDown = (event: KeyboardEvent) => {
      const kind = gesture.current?.kind;
      if (event.key !== "Escape" || !kind || kind === "pan" || kind === "pinch") return;
      event.stopPropagation(); // the editor's own Escape (deselecting) isn't wanted as well
      latest.current.finishGesture({ cancelled: true });
    };
    window.addEventListener("keydown", onKeyDown, true);
    return () => window.removeEventListener("keydown", onKeyDown, true);
  }, []);

  // A pen stroke is made at once as a dot; anything else only once the pointer has gone somewhere (see hasDragged).
  function startDraw(element: BoardElement, screen: XY, extra?: { select?: boolean }) {
    const pen = element.type === "pen";
    gesture.current = { kind: "draw", element, startScreen: screen, created: pen, done: [], ...extra };
    onSelect(null);
    if (pen) store.apply({ upsert: [element] });
  }

  function startConnector(
    type: "arrow" | "line",
    world: XY,
    screen: XY,
    vp: Viewport,
    style: Style,
    { select = false }: { select?: boolean } = {},
  ) {
    const { target, side } = connectAt(world, vp);
    // The cast: a line or an arrow is made as a connector.
    startDraw(attachEnd(createElement(type, world, style) as Connector, "start", target, side), screen, { select });
  }

  const screenPoint = (event: Located): XY => {
    // The assertion: the canvas is there once it has events (here and in the handlers and effects below).
    const rect = canvasRef.current!.getBoundingClientRect();
    return { x: event.clientX - rect.left, y: event.clientY - rect.top };
  };

  // Coalesced events give smoother strokes on fast pens and mice; only the browser's event has them, some have none.
  function extendStroke(element: PenElement, event: PointerEvent<HTMLCanvasElement>, vp: Viewport) {
    const samples = event.nativeEvent.getCoalescedEvents?.() ?? [];
    const added = (samples.length ? samples : [event]).map((sample): Point => {
      const s = screenPoint(sample);
      const point = toWorld(vp, s.x, s.y);
      return [point.x, point.y, element.pressure ? sample.pressure : 0.5];
    });
    const points = appendPoints(element.points, added);
    return points === element.points ? element : { ...element, points };
  }

  // In classroom mode, far enough inside the student's frame for the stroke.
  function startPoint(world: XY, tool: ToolId, style: Style): XY {
    const { zone: inside } = latest.current;
    return inside ? clampPoint(world, inside, edgeRoom({ type: tool as BoardElement["type"], ...style })) : world;
  }

  function keepInside(stroke: PenElement, inside: Zone): PenElement {
    if (!inside) return stroke;
    return {
      ...stroke,
      points: stroke.points.map(([x, y, pressure]): Point => {
        const point = clampPoint({ x, y }, inside, edgeRoom(stroke));
        return [point.x, point.y, pressure];
      }),
    };
  }

  function resizeShape(element: Exclude<BoardElement, PenElement>, world: XY, constrained: boolean) {
    const end = constrained
      ? constrainEnd(element.type, element.x1, element.y1, world.x, world.y)
      : { x2: world.x, y2: world.y };
    return { ...element, ...end };
  }

  function startPan(screen: XY) {
    gesture.current = { kind: "pan", startScreen: screen, startViewport: latest.current.viewport };
    setPanning(true);
  }

  function handlePointerDown(event: PointerEvent<HTMLCanvasElement>) {
    if (event.button !== 0 && event.button !== 1) return;
    // A pointer let go of without its pointerup reaching the canvas ends what it was doing, so it can't hold the canvas
    // up.
    for (const id of stalePointers(pointers.current, event.pointerId, event.pointerType, event.timeStamp))
      releasePointer(id);
    // One pointer draws and a second finger makes a pinch; a pen beside a resting palm takes over (see pressRole).
    const others = [...pointers.current.values()];
    const role = pressRole(others, event.pointerType);
    if (role === "ignore") return;
    const { viewport: vp, editingId: editing } = latest.current;
    const screen = screenPoint(event);
    canvasRef.current!.setPointerCapture(event.pointerId);
    pointers.current.set(event.pointerId, { screen, type: event.pointerType, at: event.timeStamp });

    // A focused title, frame name or color field lets go of focus (and so saves), or keys meant for the board still go
    // to it.
    const focused = document.activeElement;
    if (focused instanceof HTMLElement && focused !== document.body) focused.blur();

    if (role === "pinch") {
      finishGesture({ cancelled: true });
      const [a, b] = [others[0].screen, screen];
      gesture.current = { kind: "pinch", startDistance: distance(a, b), startMid: midpoint(a, b), startViewport: vp };
      return;
    }
    if (role === "take over") finishGesture({ cancelled: true });
    if (editing) return;

    beginGesture(event, screen);
    if (gesture.current) gesture.current.pointerId = event.pointerId;
  }

  function beginGesture(event: PointerEvent<HTMLCanvasElement>, screen: XY) {
    const { tool: activeTool, style: activeStyle, viewport: vp, spacePressed: space } = latest.current;
    const world = toWorld(vp, screen.x, screen.y);
    const tolerance = HIT_TOLERANCE / vp.zoom;

    if (event.button === 1 || space || activeTool === "hand") {
      startPan(screen);
      return;
    }
    // Classroom mode: a student's press outside their frame (or with the frame tool) pans; the editor says why or
    // offers the frame.
    const { zone: allowed } = latest.current;
    const free = activeTool === "comment" || activeTool === "vote";
    if (allowed !== undefined && !free && (activeTool === "frame" || !(allowed && pointInside(world, allowed)))) {
      onOutsideZone?.(world);
      startPan(screen);
      return;
    }

    switch (activeTool) {
      case "select": {
        // A handle on the selected element beats what's under it, bar a connection dot beside a line's end (see
        // selectPress).
        const { selected, handle: grabbed, grab } = selectPress(world, vp);
        if (grabbed) {
          // The assertions here and below: a handle is found only on the selected element, so there is one.
          // The cast: only a box has a pad, and the `?? 0` is for a line, which has none.
          const pad = (getSelectionBox(selected!, vp.zoom) as { pad?: number }).pad ?? 0;
          gesture.current = {
            kind: "transform",
            handle: grabbed,
            startScreen: screen,
            start: world,
            original: store.getElement(selected!.id)!, // as stored, for undo (it is on the board)
            from: selected!, // as drawn, to work from
            pad,
            current: null,
          };
          setHandle(grabbed);
          setTurning(grabbed === "rotate");
          return;
        }
        // Dragging from a connection dot draws an arrow out of that side, even with another arrow pinned there (see
        // dotGrab).
        if (grab) {
          startConnector("arrow", world, screen, vp, activeStyle, { select: true });
          return;
        }
        const hit = pick(world, vp);
        onSelect(hit?.id ?? null);
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
      case "vote": {
        onVote?.(world, elementAt(store.getElements(), world.x, world.y, tolerance) ?? null);
        return;
      }
      case "text": {
        const hit = elementAt(store.getElements(), world.x, world.y, tolerance);
        if (hit?.type === "text" && canChange(hit, allowed)) onEditText({ element: hit, isNew: false });
        else onEditText({ element: createElement("text", world, activeStyle), isNew: true });
        return;
      }
      case "sticky": {
        const hit = elementAt(store.getElements(), world.x, world.y, tolerance);
        if (hit?.type === "sticky" && canChange(hit, allowed)) {
          onEditText({ element: hit, isNew: false });
          return;
        }
        const note = allowed ? fitInside(createNote(world, activeStyle), allowed) : createNote(world, activeStyle);
        // The cast: fitInside moves a note, which is still a note.
        if (note) onEditText({ element: note as StickyElement, isNew: true });
        return;
      }
      case "arrow":
      case "line":
        startConnector(activeTool, startPoint(world, activeTool, activeStyle), screen, vp, activeStyle);
        return;
      default: {
        const pressure = event.pointerType === "pen" ? event.pressure : undefined;
        const element = createElement(activeTool, startPoint(world, activeTool, activeStyle), activeStyle, pressure);
        if (element.type === "frame") element.name = nextFrameName(store.getElements());
        startDraw(element, screen);
      }
    }
  }

  function continueDraw(g: DrawGesture, event: PointerEvent<HTMLCanvasElement>, world: XY, screen: XY, vp: Viewport) {
    if (g.snapped) return; // it's a shape now, drawn where the pen stopped
    if (!g.created) {
      if (!hasDragged(g.startScreen, screen)) return;
      g.created = true;
      store.apply({ upsert: [g.element] });
    } else if (!store.getElement(g.element.id)) {
      finishGesture({ cancelled: true }); // someone removed it
      return;
    }
    const { zone: inside } = latest.current;
    const point = inside ? clampPoint(world, inside, edgeRoom(g.element)) : world;
    let next =
      g.element.type === "pen"
        ? keepInside(extendStroke(g.element, event, vp), inside)
        : resizeShape(g.element, point, event.shiftKey);
    if (isConnector(next)) {
      const { target, side } = connectAt(point, vp, next.startId);
      next = attachEnd(next, "end", target, side);
    }
    // A step that would still reach outside it (an arrow's end on something outside) isn't taken.
    if (!staysInside(next, inside)) return;
    // Made from the step before, so a color someone picks mid-draw isn't painted over.
    store.apply({ upsert: [next] }, { base: [g.element] });
    g.element = next;
    if (next.type === "pen" && (!g.hold || hasDragged(g.hold.at, screen))) {
      clearTimeout(g.hold?.timer);
      g.hold = { at: screen, timer: setTimeout(() => snapToShape(g), HOLD_MS) };
    }
    if (next.type === "pen" && next.points.length >= STROKE_SPLIT_POINTS) {
      g.done.push(next);
      // The assertion: a stroke that long has points.
      g.element = { ...next, id: newId(), points: [next.points.at(-1)!] };
      store.apply({ upsert: [g.element] });
    }
  }

  function handlePointerMove(event: PointerEvent<HTMLCanvasElement>) {
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
      let overHandle: string | null = null;
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
      case "draw":
        continueDraw(g, event, world, screen, vp);
        return;
      case "erase":
        eraseAlong(g.last, world);
        g.last = world;
        return;
      case "move": {
        if (!g.originals) {
          if (!hasDragged(g.startScreen, screen)) return;
          const grabbed = store.getElement(g.id);
          if (!grabbed) {
            finishGesture({ cancelled: true });
            return;
          }
          g.originals = withContents(store.getElements(), grabbed);
          g.ready = readyToMove(store.getElements(), g.originals);
        }
        // Whatever someone removes mid-drag stays removed.
        // The assertion: `ready` is set along with `originals`.
        const { zone: inside } = latest.current;
        const [dx, dy] = inside
          ? clampShift(g.ready!, inside, world.x - g.start.x, world.y - g.start.y)
          : [world.x - g.start.x, world.y - g.start.y];
        const moved = g
          .ready!.filter((element) => store.getElement(element.id))
          .map((element) => translate(element, dx, dy));
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
            : g.from.type === "image" && g.from.id === croppingId
              ? cropImage(g.from, g.handle, world, { pad: g.pad })
              : resizeElement(g.from, g.handle, world, { keepAspect: event.shiftKey, pad: g.pad });
        if (g.handle === "start" || g.handle === "end") {
          // The casts: only a connector has end handles.
          const other = g.handle === "start" ? (next as Connector).endId : (next as Connector).startId;
          const { target, side } = connectAt(world, vp, other);
          next = attachEnd(next as Connector, g.handle, target, side);
        }
        if (!staysInside(next, latest.current.zone)) return;
        store.apply({ upsert: [next] }, { base: [g.current ?? g.original] });
        g.current = next;
        return;
      }
      default:
    }
  }

  function releasePointer(pointerId: number, { cancelled = false }: { cancelled?: boolean } = {}) {
    if (!pointers.current.delete(pointerId)) return; // not one that was taken in (see handlePointerDown)
    const g = gesture.current;
    if (g?.kind === "pinch") {
      if (pointers.current.size === 0) gesture.current = null;
      return;
    }
    if (g && pointerId !== g.pointerId) return;
    finishGesture({ cancelled });
  }

  const handlePointerUp = (event: PointerEvent<HTMLCanvasElement>) =>
    releasePointer(event.pointerId, { cancelled: event.type === "pointercancel" });

  // Capture lost without a pointerup (the window lost focus, a context menu opened) ends the gesture as a
  // pointercancel does. After a pointerup it comes too, and finds the pointer already let go of.
  const handleLostCapture = (event: PointerEvent<HTMLCanvasElement>) =>
    releasePointer(event.pointerId, { cancelled: true });

  const handlePointerLeave = () => {
    onCursorMove(null);
    if (!gesture.current) setHint(NO_HINT);
  };

  function handleDoubleClick(event: MouseEvent<HTMLCanvasElement>) {
    if (latest.current.tool !== "select") return;
    const vp = latest.current.viewport;
    const screen = screenPoint(event);
    const world = toWorld(vp, screen.x, screen.y);
    const hit = pick(world, vp);
    if (hit?.type === "text" || hit?.type === "sticky") onEditText({ element: hit, isNew: false });
    // The assertion: the hit was found on the board.
    else if (hit && isConnector(hit)) onEditText({ element: store.getElement(hit.id)!, isNew: false });
  }

  return {
    panning,
    hovering,
    handle,
    turning,
    hint,
    latest,
    handlers: {
      onPointerDown: handlePointerDown,
      onPointerMove: handlePointerMove,
      onPointerUp: handlePointerUp,
      onPointerCancel: handlePointerUp,
      onLostPointerCapture: handleLostCapture,
      onPointerLeave: handlePointerLeave,
      onDoubleClick: handleDoubleClick,
    },
  };
}
