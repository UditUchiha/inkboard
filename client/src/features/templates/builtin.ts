import type {
  Element as BoardElement,
  Font,
  FrameElement,
  ShapeElement,
  StickyElement,
  TextElement,
} from "@inkboard/shared/types";
import { newId } from "../board/elements";

// Built-in starting points for a new board. Each `build()` returns fresh elements
// (new ids and seeds), so two boards made from one template never share ids.

const INK = "#16213a";
const GREY = "#5e6676";
const seed = () => Math.floor(Math.random() * 2 ** 31) + 1;

const box = (
  x1: number,
  y1: number,
  x2: number,
  y2: number,
  { fill = null, stroke = INK, strokeWidth = 2 }: { fill?: string | null; stroke?: string; strokeWidth?: number } = {},
): ShapeElement => ({
  id: newId(),
  type: "rectangle",
  seed: seed(),
  x1,
  y1,
  x2,
  y2,
  stroke,
  fill,
  strokeWidth,
  sketchy: true,
});

const oval = (
  x1: number,
  y1: number,
  x2: number,
  y2: number,
  { fill = null, stroke = INK }: { fill?: string | null; stroke?: string } = {},
): ShapeElement => ({
  id: newId(),
  type: "ellipse",
  seed: seed(),
  x1,
  y1,
  x2,
  y2,
  stroke,
  fill,
  strokeWidth: 2,
  sketchy: true,
});

const arrow = (x1: number, y1: number, x2: number, y2: number, stroke = INK): ShapeElement => ({
  id: newId(),
  type: "arrow",
  seed: seed(),
  x1,
  y1,
  x2,
  y2,
  stroke,
  fill: null,
  strokeWidth: 2,
  sketchy: true,
  text: "",
  route: "straight",
  font: "hand",
  startHead: false,
});

const text = (
  x1: number,
  y1: number,
  value: string,
  { fontSize = 28, stroke = INK, font = "hand" }: { fontSize?: number; stroke?: string; font?: Font } = {},
): TextElement => ({
  id: newId(),
  type: "text",
  x1,
  y1,
  text: value,
  stroke,
  fontSize,
  font,
});

const frame = (x1: number, y1: number, x2: number, y2: number, name: string): FrameElement => ({
  id: newId(),
  type: "frame",
  x1,
  y1,
  x2,
  y2,
  name,
});

const note = (x: number, y: number, value: string, fill: string): StickyElement => ({
  id: newId(),
  type: "sticky",
  x1: x,
  y1: y,
  x2: x + 200,
  y2: y + 200,
  text: value,
  fill,
  font: "hand",
});

// Columns are frames, so moving one moves its notes along.
const kanban = (): BoardElement[] => {
  const columns = ["To do", "Doing", "Done"];
  const elements: BoardElement[] = [text(40, 20, "Project board", { fontSize: 44 })];
  columns.forEach((title, index) => {
    const x = 40 + index * 300;
    elements.push(frame(x, 120, x + 270, 640, title));
  });
  elements.push(note(75, 150, "First task", "#ffec99"), note(375, 150, "Drag notes across", "#a5d8ff"));
  return elements;
};

// Attaches an arrow's ends to shapes, so they stay connected when the shapes move.
const connect = (element: ShapeElement, from: BoardElement, to: BoardElement): ShapeElement => ({
  ...element,
  startId: from.id,
  endId: to.id,
});

const flowchart = (): BoardElement[] => {
  const start = oval(240, 100, 440, 170, { fill: "#b2f2bb" });
  const step = box(240, 234, 440, 314, { fill: "#a5d8ff" });
  const decision = box(280, 378, 400, 478, { fill: "#ffec99" });
  const end = oval(522, 394, 682, 462, { fill: "#d0bfff" });
  return [
    text(40, 20, "Flowchart", { fontSize: 44 }),
    start,
    text(300, 118, "Start", { fontSize: 28 }),
    connect(arrow(340, 172, 340, 232), start, step),
    step,
    text(282, 258, "Do a step", { fontSize: 28 }),
    connect(arrow(340, 316, 340, 376), step, decision),
    decision,
    text(310, 410, "Done?", { fontSize: 28 }),
    connect(arrow(402, 428, 520, 428), decision, end),
    text(430, 392, "yes", { fontSize: 22, stroke: GREY }),
    end,
    text(568, 408, "End", { fontSize: 28 }),
    // "No" goes back round to the step, as one arrow attached at both ends.
    connect(
      { ...arrow(278, 428, 238, 274), route: "elbow", startAnchor: "left", endAnchor: "left", text: "no" },
      decision,
      step,
    ),
  ];
};

const retrospective = (): BoardElement[] => {
  const columns: [title: string, fill: string, example: string][] = [
    ["Went well", "#b2f2bb", "Shipped on time"],
    ["Could be better", "#ffec99", "Too many meetings"],
    ["Actions", "#a5d8ff", "Try a no-meeting day"],
  ];
  const elements: BoardElement[] = [text(40, 20, "Retrospective", { fontSize: 44 })];
  columns.forEach(([title, fill, example], index) => {
    const x = 40 + index * 300;
    elements.push(frame(x, 120, x + 270, 600, title), note(x + 35, 150, example, fill));
  });
  return elements;
};

const swot = (): BoardElement[] => {
  const cells: [title: string, fill: string, x: number, y: number][] = [
    ["Strengths", "#b2f2bb", 40, 100],
    ["Weaknesses", "#ffc9c9", 340, 100],
    ["Opportunities", "#a5d8ff", 40, 340],
    ["Threats", "#ffec99", 340, 340],
  ];
  const elements: BoardElement[] = [text(40, 20, "SWOT analysis", { fontSize: 44 })];
  for (const [title, fill, x, y] of cells) {
    elements.push(box(x, y, x + 280, y + 220, { fill: null, stroke: GREY, strokeWidth: 1 }));
    elements.push(box(x, y, x + 280, y + 48, { fill }));
    elements.push(text(x + 14, y + 6, title, { fontSize: 28 }));
  }
  return elements;
};

const brainstorm = (): BoardElement[] => {
  const spokes: [dx: number, dy: number][] = [
    [-1, -1],
    [1, -1],
    [-1, 1],
    [1, 1],
  ];
  const cx = 400;
  const cy = 280;
  const elements: BoardElement[] = [
    oval(cx - 110, cy - 50, cx + 110, cy + 50, { fill: "#ffec99" }),
    text(cx - 70, cy - 18, "Big idea", { fontSize: 32 }),
  ];
  for (const [dx, dy] of spokes) {
    const bx = cx + dx * 250;
    const by = cy + dy * 170;
    const idea = oval(bx - 80, by - 34, bx + 80, by + 34, { fill: "#a5d8ff" });
    elements.push(connect(arrow(cx + dx * 80, cy + dy * 38, bx - dx * 70, by - dy * 30), elements[0], idea));
    elements.push(idea);
    elements.push(text(bx - 36, by - 14, "Idea", { fontSize: 26 }));
  }
  return elements;
};

/** A ready-made start for a board: `build()` gives its elements, freshly made on every call. */
export type BuiltinTemplate = { id: string; title: string; detail: string; build: () => BoardElement[] };

export const BUILTIN_TEMPLATES: BuiltinTemplate[] = [
  { id: "kanban", title: "Kanban board", detail: "Three columns to move work across", build: kanban },
  { id: "flowchart", title: "Flowchart", detail: "Steps, a decision and a way back", build: flowchart },
  { id: "retro", title: "Retrospective", detail: "What went well, what to fix, what's next", build: retrospective },
  { id: "swot", title: "SWOT analysis", detail: "Strengths, weaknesses, opportunities, threats", build: swot },
  { id: "brainstorm", title: "Brainstorm", detail: "A big idea with four branches", build: brainstorm },
];
