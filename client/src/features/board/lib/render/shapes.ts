import type { Element as BoardElement, PenElement, ShapeElement } from "@inkboard/shared/types";
import getStroke from "perfect-freehand";
import rough from "roughjs";
import type { Drawable, Options, PathInfo } from "roughjs/bin/core";
import { arrowHeads } from "../elements/elements";
import { normalizeRect, polygonCorners } from "../elements/geometry";
import { connectorPath, pathData } from "../elements/routes";
import { createDrawingCache } from "./drawCache";
import { darkInk, sameInk } from "./ink";
import type { Ink } from "./ink";

const generator = rough.generator();

// Elements are immutable, so generated shapes are cached per object (and reused for moved copies); light and dark keep
// separate caches.
const drawableCaches = { light: createDrawingCache<Drawable[]>(), dark: createDrawingCache<Drawable[]>() };
const penPathCache = createDrawingCache<Path2D>();

function roughOptions(element: ShapeElement, paint: Ink): Options {
  const sketchy = element.sketchy !== false;
  return {
    seed: element.seed,
    stroke: paint(element.stroke),
    strokeWidth: element.strokeWidth,
    roughness: sketchy ? 1.1 : 0,
    bowing: sketchy ? 1 : 0,
    disableMultiStroke: !sketchy,
    preserveVertices: !sketchy,
    fill: element.fill ? paint(element.fill) : undefined,
    fillStyle: sketchy ? "hachure" : "solid",
    fillWeight: Math.max(element.strokeWidth / 2, 0.75),
    hachureGap: 4 + element.strokeWidth * 2,
  };
}

function buildDrawables(element: ShapeElement, paint: Ink): Drawable[] {
  const options = roughOptions(element, paint);
  const { x1, y1, x2, y2 } = element;
  switch (element.type) {
    case "line":
    case "arrow": {
      const path = connectorPath(element);
      let body: Drawable;
      if (path.curved) body = generator.path(pathData(path), options);
      else if (path.points.length > 2)
        body = generator.linearPath(
          path.points.map(({ x, y }) => [x, y]),
          options,
        );
      else body = generator.line(x1, y1, x2, y2, options);
      return [body, ...arrowHeads(element).map((head) => generator.linearPath(head, options))];
    }
    case "rectangle": {
      const r = normalizeRect(x1, y1, x2, y2);
      return [generator.rectangle(r.x, r.y, r.width, r.height, options)];
    }
    case "ellipse": {
      const r = normalizeRect(x1, y1, x2, y2);
      if (r.width < 1 || r.height < 1) return [];
      return [generator.ellipse(r.x + r.width / 2, r.y + r.height / 2, r.width, r.height, options)];
    }
    case "triangle":
    case "diamond": {
      return [generator.polygon(polygonCorners(element.type, normalizeRect(x1, y1, x2, y2))!, options)];
    }
    default:
      return [];
  }
}

const average = (a: number, b: number): number => (a + b) / 2;

function svgPathFromOutline(points: number[][]): string {
  if (points.length < 4) return "";
  let [a, b] = points;
  const c = points[2];
  let path = `M${a[0].toFixed(2)},${a[1].toFixed(2)} Q${b[0].toFixed(2)},${b[1].toFixed(2)} ${average(b[0], c[0]).toFixed(2)},${average(b[1], c[1]).toFixed(2)} T`;
  for (let i = 2; i < points.length - 1; i += 1) {
    a = points[i];
    b = points[i + 1];
    path += `${average(a[0], b[0]).toFixed(2)},${average(a[1], b[1]).toFixed(2)} `;
  }
  return `${path}Z`;
}

export function penOutline(element: PenElement): string {
  const outline = getStroke(element.points, {
    size: element.penSize,
    thinning: 0.55,
    smoothing: 0.5,
    streamline: 0.45,
    simulatePressure: !element.pressure,
  });
  return svgPathFromOutline(outline);
}

export const penPath = (element: PenElement) =>
  penPathCache.get(element, (stroke) => new Path2D(penOutline(stroke as PenElement)));

export function shapePaths(element: ShapeElement): PathInfo[] {
  return buildDrawables(element, sameInk).flatMap((drawable) => generator.toPaths(drawable));
}

const buildLight = (element: BoardElement) => buildDrawables(element as ShapeElement, sameInk);
const buildDark = (element: BoardElement) => buildDrawables(element as ShapeElement, darkInk);

export const drawablesOf = (element: BoardElement, dark: boolean) =>
  dark ? drawableCaches.dark.get(element, buildDark) : drawableCaches.light.get(element, buildLight);

export function trimShapeCaches(count: number) {
  for (const cache of [drawableCaches.light, drawableCaches.dark, penPathCache]) cache.trim(count);
}
