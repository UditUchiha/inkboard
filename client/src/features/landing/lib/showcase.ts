import type { Element as BoardElement, PenElement, Point } from "@inkboard/shared/types";
import type { SuggestionMark } from "../../board/lib/sync/suggestions";

// A showcase scene is a short, looping film of a board: timed steps in a 640 × 400 coordinate space.
export const SHOW_WIDTH = 640;
export const SHOW_HEIGHT = 400;
export const HOLD_MS = 2200; // the finished scene stays before it loops

export type Person = { name: string; color: string };

export type Step =
  | { at: number; add: BoardElement }
  | { at: number; stroke: PenElement; over: number; by?: Person } // drawn point by point over `over` ms
  | { at: number; remove: string }
  | { at: number; suggest: BoardElement; by: Person }
  | { at: number; accept: string } // a suggested element's id: it becomes part of the board
  | { at: number; claim: { frameId: string; by: Person } }
  | { at: number; cursor: { by: Person; x: number; y: number } }
  | { at: number; note: string | null };

export type Scene = { duration: number; steps: Step[] };

export type Cursor = { by: Person; x: number; y: number };

export type SceneState = {
  elements: BoardElement[];
  suggestions: SuggestionMark[];
  claims: Map<string, { name: string; mine: boolean }>;
  cursors: Cursor[];
  note: string | null;
};

const clamp01 = (value: number) => Math.min(1, Math.max(0, value));

export function stateAt(scene: Scene, time: number): SceneState {
  const elements = new Map<string, BoardElement>();
  const suggested = new Map<string, SuggestionMark>();
  const claims = new Map<string, { name: string; mine: boolean }>();
  const cursors = new Map<string, Cursor>();
  let note: string | null = null;

  for (const step of scene.steps) {
    if (step.at > time) continue;
    if ("add" in step) elements.set(step.add.id, step.add);
    else if ("remove" in step) elements.delete(step.remove);
    else if ("stroke" in step) {
      const progress = clamp01((time - step.at) / step.over);
      const count = Math.max(1, Math.round(progress * step.stroke.points.length));
      const points = step.stroke.points.slice(0, count);
      elements.set(step.stroke.id, { ...step.stroke, points });
      if (step.by && progress < 1) {
        const [x, y] = points[points.length - 1] as Point;
        cursors.set(step.by.name, { by: step.by, x: x + 4, y: y + 2 });
      }
    } else if ("suggest" in step) {
      suggested.set(step.suggest.id, {
        id: `add:${step.suggest.id}`,
        kind: "add",
        element: step.suggest,
        color: step.by.color,
        outdated: false,
        highlighted: false,
        ghost: false,
      });
    } else if ("accept" in step) {
      const mark = suggested.get(step.accept);
      if (mark) {
        suggested.delete(step.accept);
        elements.set(mark.element.id, mark.element);
      }
    } else if ("claim" in step) claims.set(step.claim.frameId, { name: step.claim.by.name, mine: false });
    else if ("cursor" in step) cursors.set(step.cursor.by.name, step.cursor);
    else note = step.note;
  }

  return {
    elements: [...elements.values()],
    suggestions: [...suggested.values()],
    claims,
    cursors: [...cursors.values()],
    note,
  };
}

// Where a looping scene is at `elapsed` ms since it began: it plays, holds, and starts over.
export const loopTime = (scene: Scene, elapsed: number) => elapsed % (scene.duration + HOLD_MS);

// Strokes made of simple geometry, so a scene can "handwrite" without a point list per letter. Points are filled
// in every few units: the pen renderer smooths between points, which would round a corner given only its two ends.
export function polyline(id: string, stroke: string, points: [number, number][], penSize = 4): PenElement {
  const dense: Point[] = [];
  points.forEach(([x, y], i) => {
    if (i > 0) {
      const [px, py] = points[i - 1];
      const segments = Math.max(1, Math.ceil(Math.hypot(x - px, y - py) / 6));
      for (let s = 1; s < segments; s += 1)
        dense.push([px + ((x - px) * s) / segments, py + ((y - py) * s) / segments, 0.5]);
    }
    dense.push([x, y, 0.5]);
  });
  return { id, type: "pen", pressure: false, stroke, penSize, points: dense };
}

export function arcPoints(cx: number, cy: number, rx: number, ry: number, from: number, to: number, steps = 24) {
  const points: [number, number][] = [];
  for (let i = 0; i <= steps; i += 1) {
    const angle = from + ((to - from) * i) / steps;
    points.push([cx + Math.cos(angle) * rx, cy + Math.sin(angle) * ry]);
  }
  return points;
}

export function wobbly(points: [number, number][], amount = 1.2, seed = 1): [number, number][] {
  return points.map(([x, y], i) => [x + Math.sin(i * 1.7 + seed) * amount, y + Math.cos(i * 1.3 + seed) * amount]);
}
