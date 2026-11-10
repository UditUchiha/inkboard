import type { Element as BoardElement, ShapeElement } from "@inkboard/shared/types";
import type { Dispatch, RefObject, SetStateAction } from "react";
import { ERASER_RADIUS } from "../constants/board";
import type { Style, ToolId } from "../constants/board";
import { canChange, staysInside } from "../lib/elements/classroom";
import type { Zone } from "../lib/elements/classroom";
import type { Connection } from "../lib/elements/connectors";
import { resolveConnectors } from "../lib/elements/connectors";
import { createElement, frameContents, hitTest, isDegenerate, isFrame } from "../lib/elements/elements";
import type { Connector } from "../lib/elements/elements";
import type { HeldPointer, Viewport, XY } from "../lib/elements/geometry";
import { recognizeStroke } from "../lib/elements/recognize";
import type { BoardStore } from "../lib/sync/store";
import { NO_HINT } from "./useCanvasHints";
import type { Hint } from "./useCanvasHints";

// `kind` says what the pointer (`pointerId`) is doing.
export type PanGesture = { kind: "pan"; startScreen: XY; startViewport: Viewport };
export type PinchGesture = { kind: "pinch"; startDistance: number; startMid: XY; startViewport: Viewport };
// `hold` and its timer turn a pen stroke held still into a shape; `done` holds the earlier strokes of a long one.
export type DrawGesture = {
  kind: "draw";
  element: BoardElement;
  startScreen: XY;
  created: boolean;
  done: BoardElement[];
  select?: boolean;
  hold?: { at: XY; timer: ReturnType<typeof setTimeout> };
  snapped?: boolean;
};

export const HOLD_MS = 600; // how long a pen is held still at the end of a stroke for it to become a shape
const MIN_SHAPE = 24; // screen pixels: a stroke smaller than this is never made a shape
// `released`: connectors let go of what's erased, as they were before; `letGo`: as they are now.
export type EraseGesture = {
  kind: "erase";
  erased: Map<string, BoardElement>;
  released: Map<string, Connector>;
  letGo: Map<string, Connector>;
  last: XY;
};
// Nothing moves before the pointer has gone somewhere, so `originals`, `ready` and `current` are set when the drag
// begins.
export type MoveGesture = {
  kind: "move";
  startScreen: XY;
  start: XY;
  id: string;
  originals?: BoardElement[];
  ready?: BoardElement[];
  current: BoardElement[] | null;
};
export type TransformGesture = {
  kind: "transform";
  handle: string;
  startScreen: XY;
  start: XY;
  original: BoardElement;
  from: BoardElement;
  pad: number;
  current: BoardElement | null;
};
export type Gesture = (PanGesture | PinchGesture | DrawGesture | EraseGesture | MoveGesture | TransformGesture) & {
  pointerId?: number;
};

export type Held = HeldPointer & { type: string; at: number; screen: XY };

export interface Latest {
  tool: ToolId;
  style: Style;
  viewport: Viewport;
  spacePressed: boolean;
  editingId?: string | undefined;
  selectedId: string | null;
  zone?: Zone;
  hovering: boolean;
  handle: string | null;
  finishGesture: (options?: { cancelled?: boolean }) => void;
}

export type Under = { found?: Connection; hit?: BoardElement | null };

interface GestureLifecycleOptions {
  store: BoardStore;
  gesture: RefObject<Gesture | null>;
  latest: RefObject<Latest>;
  setPanning: Dispatch<SetStateAction<boolean>>;
  setTurning: Dispatch<SetStateAction<boolean>>;
  setHandle: Dispatch<SetStateAction<string | null>>;
  setHint: Dispatch<SetStateAction<Hint>>;
  onSelect: (id: string | null) => void;
  onFrameDrawn?: ((id: string) => void) | undefined;
}

// How a pointer gesture ends, and what the eraser and a held pen do along the way.
export function useGestureLifecycle({
  store,
  gesture,
  latest,
  setPanning,
  setTurning,
  setHandle,
  setHint,
  onSelect,
  onFrameDrawn,
}: GestureLifecycleOptions) {
  function eraseAlong(from: XY, to: XY) {
    // The cast: this only runs for an erase gesture.
    const g = gesture.current as EraseGesture;
    const { zoom } = latest.current.viewport;
    const radius = ERASER_RADIUS / zoom;
    // Sample along the path so fast strokes don't skip over thin lines.
    const steps = Math.max(1, Math.ceil(Math.hypot(to.x - from.x, to.y - from.y) / radius));
    const hits = new Map<string, BoardElement>();
    for (const element of resolveConnectors(store.getElements())) {
      for (let i = 0; i <= steps; i += 1) {
        const x = from.x + ((to.x - from.x) * i) / steps;
        const y = from.y + ((to.y - from.y) * i) / steps;
        if (canChange(element, latest.current.zone) && hitTest(element, x, y, radius)) {
          // As it was before this stroke, if the stroke has already let it go of a shape.
          // The assertion: it was read from the board just now.
          hits.set(element.id, g.released.get(element.id) ?? store.getElement(element.id)!);
          break;
        }
      }
    }
    if (hits.size === 0) return;
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

  // Records the gesture as an undo step, or puts back what it changed if `cancelled`; what someone else removed stays
  // removed.
  function finishGesture({ cancelled = false } = {}) {
    const g = gesture.current;
    gesture.current = null;
    setPanning(false);
    if (!g) return;

    setHint(NO_HINT);
    if (g.kind === "draw") clearTimeout(g.hold?.timer);
    const live = (element: BoardElement) => Boolean(store.getElement(element.id));
    if (g.kind === "draw" && g.created) {
      const strokes = [...g.done, g.element].filter(live);
      const ids = strokes.map((element) => element.id);
      if (cancelled || isDegenerate(g.element, latest.current.viewport.zoom)) store.apply({ remove: ids });
      else if (strokes.length > 0) {
        store.record({ undo: { remove: ids }, redo: { upsert: strokes } });
        if (g.element.type === "frame") onFrameDrawn?.(g.element.id);
        if (g.select) onSelect(g.element.id);
      }
    } else if (g.kind === "erase" && g.erased.size > 0) {
      const released = [...g.released.keys()].filter((id) => !g.erased.has(id));
      // The assertions: `released` has the ids of g.released, and g.letGo has an entry for each of them.
      const undo = { upsert: [...g.erased.values(), ...released.map((id) => g.released.get(id)!)] };
      const letGo = released.map((id) => g.letGo.get(id)!);
      if (cancelled) store.apply(undo, { base: letGo });
      else store.record({ undo, redo: { remove: [...g.erased.keys()] }, undoBase: letGo });
    } else if (g.kind === "move" && g.current) {
      const current = g.current.filter(live);
      // The assertion: `current` is set along with `originals`.
      const originals = g.originals!.filter((element) => current.some(({ id }) => id === element.id));
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

  // A pen stroke held still at its end becomes the shape it looks like (see recognize.ts); long multi-part strokes
  // stay.
  function snapToShape(g: DrawGesture) {
    if (gesture.current !== g || g.element.type !== "pen" || g.done.length > 0 || !store.getElement(g.element.id))
      return;
    const { style, viewport } = latest.current;
    const shape = recognizeStroke(g.element.points, MIN_SHAPE / viewport.zoom);
    if (!shape) return;
    // The cast: none of these types is a pen, so it has a box.
    const made = createElement(shape.type, { x: shape.x1, y: shape.y1 }, { ...style, stroke: g.element.stroke });
    const drawn = { ...(made as ShapeElement), x2: shape.x2, y2: shape.y2, ...(shape.angle && { angle: shape.angle }) };
    if (!staysInside(drawn, latest.current.zone)) return;
    store.apply({ remove: [g.element.id], upsert: [drawn] });
    g.element = drawn;
    g.snapped = true;
  }

  return { eraseAlong, finishGesture, snapToShape };
}
