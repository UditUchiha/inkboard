import { newId } from "../board/elements";

// Built-in starting points for a new board. Each `build()` returns fresh elements
// (new ids and seeds), so two boards made from one template never share ids.

const INK = "#16213a";
const GREY = "#5e6676";
const seed = () => Math.floor(Math.random() * 2 ** 31) + 1;

const box = (x1, y1, x2, y2, { fill = null, stroke = INK, strokeWidth = 2 } = {}) => ({
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

const oval = (x1, y1, x2, y2, { fill = null, stroke = INK } = {}) => ({
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

const arrow = (x1, y1, x2, y2, stroke = INK) => ({
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
});

const line = (x1, y1, x2, y2, stroke = GREY) => ({ ...arrow(x1, y1, x2, y2, stroke), type: "line" });

const text = (x1, y1, value, { fontSize = 28, stroke = INK, font = "hand" } = {}) => ({
  id: newId(),
  type: "text",
  x1,
  y1,
  text: value,
  stroke,
  fontSize,
  font,
});

const frame = (x1, y1, x2, y2, name) => ({ id: newId(), type: "frame", x1, y1, x2, y2, name });

const note = (x, y, value, fill) => ({
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
const kanban = () => {
  const columns = ["To do", "Doing", "Done"];
  const elements = [text(40, 20, "Project board", { fontSize: 44 })];
  columns.forEach((title, index) => {
    const x = 40 + index * 300;
    elements.push(frame(x, 120, x + 270, 640, title));
  });
  elements.push(note(75, 150, "First task", "#ffec99"), note(375, 150, "Drag notes across", "#a5d8ff"));
  return elements;
};

// Attaches an arrow's ends to shapes, so they stay connected when the shapes move.
const connect = (element, from, to) => ({ ...element, startId: from.id, endId: to.id });

const flowchart = () => {
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
    arrow(278, 428, 150, 428),
    text(200, 392, "no", { fontSize: 22, stroke: GREY }),
    line(150, 428, 150, 274),
    arrow(150, 274, 238, 274),
  ];
};

const retrospective = () => {
  const columns = [
    ["Went well", "#b2f2bb", "Shipped on time"],
    ["Could be better", "#ffec99", "Too many meetings"],
    ["Actions", "#a5d8ff", "Try a no-meeting day"],
  ];
  const elements = [text(40, 20, "Retrospective", { fontSize: 44 })];
  columns.forEach(([title, fill, example], index) => {
    const x = 40 + index * 300;
    elements.push(frame(x, 120, x + 270, 600, title), note(x + 35, 150, example, fill));
  });
  return elements;
};

const swot = () => {
  const cells = [
    ["Strengths", "#b2f2bb", 40, 100],
    ["Weaknesses", "#ffc9c9", 340, 100],
    ["Opportunities", "#a5d8ff", 40, 340],
    ["Threats", "#ffec99", 340, 340],
  ];
  const elements = [text(40, 20, "SWOT analysis", { fontSize: 44 })];
  for (const [title, fill, x, y] of cells) {
    elements.push(box(x, y, x + 280, y + 220, { fill: null, stroke: GREY, strokeWidth: 1 }));
    elements.push(box(x, y, x + 280, y + 48, { fill }));
    elements.push(text(x + 14, y + 6, title, { fontSize: 28 }));
  }
  return elements;
};

const brainstorm = () => {
  const spokes = [
    [-1, -1],
    [1, -1],
    [-1, 1],
    [1, 1],
  ];
  const cx = 400;
  const cy = 280;
  const elements = [
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

export const BUILTIN_TEMPLATES = [
  { id: "kanban", title: "Kanban board", detail: "Three columns to move work across", build: kanban },
  { id: "flowchart", title: "Flowchart", detail: "Steps, a decision and two endings", build: flowchart },
  { id: "retro", title: "Retrospective", detail: "What went well, what to fix, what's next", build: retrospective },
  { id: "swot", title: "SWOT analysis", detail: "Strengths, weaknesses, opportunities, threats", build: swot },
  { id: "brainstorm", title: "Brainstorm", detail: "A big idea with four branches", build: brainstorm },
];
