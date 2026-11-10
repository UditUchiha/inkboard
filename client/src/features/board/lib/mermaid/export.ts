import type { Element as BoardElement, FrameElement, ShapeElement, StickyElement } from "@inkboard/shared/types";
import { FILLABLE_TYPES } from "../../constants/board";
import { getBounds, isFrame } from "../elements/elements";
import { normalizeRect, rectContains } from "../elements/geometry";
import type { Rect } from "../elements/geometry";
import { QUIET } from "./sequence";

const quote = (text: string) => `"${text.replace(/"/g, "#quot;").replace(/\r?\n/g, "<br>")}"`;

const middleOf = (box: Rect) => ({ x: box.x + box.width / 2, y: box.y + box.height / 2 });
const area = (box: Rect) => box.width * box.height;

function labelShapes(elements: BoardElement[], shapes: BoardElement[]) {
  const boxes = new Map(shapes.map((shape) => [shape.id, getBounds(shape)]));
  const labels = new Map<string, string[]>();
  const labelOf = new Map<string, string>(); // a text element's id -> the shape it labels
  for (const element of elements) {
    if (element.type !== "text") continue;
    const centre = middleOf(getBounds(element));
    const holder = shapes
      .filter((shape) => shape.type !== "sticky" && rectContains(boxes.get(shape.id)!, centre.x, centre.y))
      .sort((a, b) => area(boxes.get(a.id)!) - area(boxes.get(b.id)!))[0];
    if (!holder) continue;
    labels.set(holder.id, [...(labels.get(holder.id) ?? []), element.text]);
    labelOf.set(element.id, holder.id);
  }
  return { labels, labelOf };
}

export function elementsToMermaid(elements: BoardElement[]): string | null {
  const sequence = elementsToSequence(elements);
  if (sequence) return sequence;
  const shapes = elements.filter((element) => element.type === "sticky" || FILLABLE_TYPES.has(element.type));
  if (shapes.length === 0) return null;
  const boxes = new Map(shapes.map((shape) => [shape.id, getBounds(shape)]));
  const nodeId = new Map(shapes.map((shape, index) => [shape.id, `n${index + 1}`]));
  const { labels, labelOf } = labelShapes(elements, shapes);

  const frames = elements.filter(isFrame);
  const frameBoxes = new Map(frames.map((frame) => [frame.id, getBounds(frame)]));
  const innermost = (box: Rect, except?: string) =>
    frames
      .filter((frame) => frame.id !== except)
      .filter((frame) => {
        const { x, y } = middleOf(box);
        const outer = frameBoxes.get(frame.id)!;
        return rectContains(outer, x, y) && area(outer) > area(box);
      })
      .sort((a, b) => area(frameBoxes.get(a.id)!) - area(frameBoxes.get(b.id)!))[0]?.id ?? null;
  const parentOf = new Map<string, string | null>();
  for (const shape of shapes) parentOf.set(shape.id, innermost(boxes.get(shape.id)!));
  for (const frame of frames) parentOf.set(frame.id, innermost(frameBoxes.get(frame.id)!, frame.id));

  const centres = shapes.map((shape) => middleOf(boxes.get(shape.id)!));
  const spreadX = Math.max(...centres.map((c) => c.x)) - Math.min(...centres.map((c) => c.x));
  const spreadY = Math.max(...centres.map((c) => c.y)) - Math.min(...centres.map((c) => c.y));
  const lines = [`flowchart ${spreadX > spreadY ? "LR" : "TD"}`];

  const nodeLine = (shape: BoardElement) => {
    const label = shape.type === "sticky" ? shape.text : (labels.get(shape.id) ?? []).join("\n");
    const text = quote(label || " ");
    const turned =
      shape.type === "rectangle" && Math.abs((Math.abs(shape.angle ?? 0) % (Math.PI / 2)) - Math.PI / 4) < 0.01;
    if (turned || shape.type === "diamond") return `${nodeId.get(shape.id)}{${text}}`;
    return shape.type === "ellipse" ? `${nodeId.get(shape.id)}([${text}])` : `${nodeId.get(shape.id)}[${text}]`;
  };
  const write = (parent: string | null, indent: string) => {
    for (const shape of shapes) if (parentOf.get(shape.id) === parent) lines.push(indent + nodeLine(shape));
    frames.forEach((frame, index) => {
      if (parentOf.get(frame.id) !== parent) return;
      lines.push(`${indent}subgraph f${index + 1}[${quote(frame.name || "Frame")}]`);
      write(frame.id, `${indent}  `);
      lines.push(`${indent}end`);
    });
  };
  write(null, "  ");

  const endOf = (id: string | undefined) => (id && labelOf.get(id)) ?? id;
  for (const element of elements) {
    if (element.type !== "arrow" && element.type !== "line") continue;
    const from = nodeId.get(endOf(element.startId) ?? "");
    const to = nodeId.get(endOf(element.endId) ?? "");
    if (!from || !to) continue;
    const link = element.type === "line" ? "---" : element.startHead ? "<-->" : "-->";
    lines.push(`  ${from} ${link}${element.text ? `|${quote(element.text)}|` : ""} ${to}`);
  }
  for (const shape of shapes) {
    const fill = "fill" in shape ? shape.fill : null;
    if (fill) lines.push(`  style ${nodeId.get(shape.id)} fill:${fill}`);
  }
  return `${lines.join("\n")}\n`;
}

const plain = (text: string) => text.replace(/\r?\n/g, "<br>").replace(/;/g, "#59;");
const FRAME_BLOCK = /^(loop|alt|opt|par|critical|break|else|and|option)(?:\s+([\s\S]*))?$/i;
// The box a shape, note or frame is drawn in: getBounds adds the stroke, and a frame's name above it.
const outline = (element: ShapeElement | StickyElement | FrameElement) =>
  normalizeRect(element.x1, element.y1, element.x2, element.y2);

function elementsToSequence(elements: BoardElement[]): string | null {
  const shapes = elements.filter(
    (element): element is ShapeElement => element.type === "rectangle" || element.type === "ellipse",
  );
  const lifelines: { id: string; x: number; top: number; bottom: number; shape: ShapeElement }[] = [];
  for (const line of elements) {
    if (line.type !== "line" || line.startId || line.endId || Math.abs(line.x1 - line.x2) > 2) continue;
    const [top, bottom] = [Math.min(line.y1, line.y2), Math.max(line.y1, line.y2)];
    const shape = shapes.find((candidate) => {
      const box = outline(candidate);
      const below = top - (box.y + box.height);
      return below > -2 && below < 30 && line.x1 > box.x && line.x1 < box.x + box.width;
    });
    if (shape && bottom - top > 40 && !lifelines.some((known) => known.shape === shape)) {
      lifelines.push({ id: line.id, x: line.x1, top, bottom, shape });
    }
  }
  if (lifelines.length === 0) return null;
  lifelines.sort((a, b) => a.x - b.x);
  const top = Math.min(...lifelines.map((lifeline) => lifeline.top));
  const bottom = Math.max(...lifelines.map((lifeline) => lifeline.bottom));
  const nearest = (x: number) =>
    lifelines.reduce(
      (best, lifeline, index) => (Math.abs(lifeline.x - x) < Math.abs(lifelines[best].x - x) ? index : best),
      0,
    );

  // A participant's id is its name when that's a plain word, or else p1, p2… with the name as its alias.
  const { labels } = labelShapes(elements, shapes);
  const names = lifelines.map(({ shape }) => (labels.get(shape.id) ?? []).join("\n"));
  const ids = names.map((name, index) =>
    /^[\p{L}\p{N}_]+$/u.test(name) && !/^p\d+$/.test(name) && names.indexOf(name) === index ? name : `p${index + 1}`,
  );
  const lines = ["sequenceDiagram"];
  lifelines.forEach(({ shape }, index) => {
    const kind = shape.type === "ellipse" ? "actor" : "participant";
    const alias = ids[index] === names[index] ? "" : ` as ${plain(names[index] || ids[index])}`;
    lines.push(`  ${kind} ${ids[index]}${alias}`);
  });

  // Everything else as it comes down the page. Where two things are level, a block's end comes before what follows.
  const events: { y: number; rank: number; line: string; change: -1 | 0 | 1; outdent?: boolean }[] = [];
  const lifelineIds = new Set(lifelines.map((lifeline) => lifeline.id));
  for (const element of elements) {
    if (element.type === "line" || element.type === "arrow") {
      if (lifelineIds.has(element.id)) continue;
      const y = Math.min(element.y1, element.y2);
      const from = nearest(element.x1);
      // A message ends on the lifeline it goes to, or, an elbow out to the side, is to the one it starts on.
      const onEnd = Math.abs(lifelines[nearest(element.x2)].x - element.x2) < 20;
      const to = onEnd ? nearest(element.x2) : element.route === "elbow" ? from : -1;
      if (Math.abs(lifelines[from].x - element.x1) >= 20 || to < 0 || y < top || y > bottom) continue;
      const dotted = element.stroke === QUIET;
      const arrow =
        element.type === "line"
          ? dotted
            ? "-->"
            : "->"
          : `${element.startHead ? "<<" : ""}${dotted ? "-->>" : "->>"}`;
      events.push({ y, rank: 2, change: 0, line: `${ids[from]}${arrow}${ids[to]}: ${plain(element.text ?? "")}` });
    } else if (element.type === "sticky") {
      const box = outline(element);
      if (box.y < top || box.y > bottom) continue;
      const over = lifelines.flatMap((lifeline, index) =>
        lifeline.x >= box.x && lifeline.x <= box.x + box.width ? [index] : [],
      );
      const beside = nearest(box.x + box.width / 2);
      const where =
        over.length > 0
          ? `over ${[...new Set([over[0], over.at(-1)!])].map((index) => ids[index]).join(",")}`
          : `${box.x + box.width / 2 < lifelines[beside].x ? "left of" : "right of"} ${ids[beside]}`;
      events.push({ y: box.y, rank: 2, change: 0, line: `Note ${where}: ${plain(element.text)}` });
    } else if (isFrame(element)) {
      const block = FRAME_BLOCK.exec(element.name.trim());
      if (!block) continue;
      const box = outline(element);
      const keyword = block[1].toLowerCase();
      const line = `${keyword}${block[2] ? ` ${plain(block[2])}` : ""}`;
      if (keyword === "else" || keyword === "and" || keyword === "option") {
        events.push({ y: box.y, rank: 1, change: 0, outdent: true, line });
      } else {
        events.push(
          { y: box.y, rank: 1, change: 1, line },
          { y: box.y + box.height, rank: 0, change: -1, line: "end" },
        );
      }
    }
  }
  events.sort((a, b) => a.y - b.y || a.rank - b.rank);
  let depth = 1;
  for (const { line, change, outdent } of events) {
    if (change < 0) depth = Math.max(1, depth - 1);
    lines.push(`${"  ".repeat(Math.max(1, depth - (outdent ? 1 : 0)))}${line}`);
    if (change > 0) depth += 1;
  }
  return `${lines.join("\n")}\n`;
}
