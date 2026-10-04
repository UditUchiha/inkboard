// The sketch shown on the landing page, in a 640 × 440 coordinate space.
export const SCENE_WIDTH = 640;
export const SCENE_HEIGHT = 440;

const INK = "#16213a";

const shape = (id, type, x1, y1, x2, y2, extra = {}) => ({
  id,
  type,
  seed: id.length * 7919 + x1,
  x1,
  y1,
  x2,
  y2,
  stroke: INK,
  fill: null,
  strokeWidth: 2,
  sketchy: true,
  ...extra,
});

const text = (id, x1, y1, value, fontSize = 30, extra = {}) => ({
  id,
  type: "text",
  x1,
  y1,
  text: value,
  stroke: INK,
  fontSize,
  font: "hand",
  ...extra,
});

export const DEMO_ELEMENTS = [
  text("title", 44, 30, "Launch plan", 40),
  shape("research", "rectangle", 56, 122, 222, 202, { fill: "#a5d8ff" }),
  text("research-label", 92, 144, "Research"),
  shape("arrow-1", "arrow", 234, 162, 304, 162),
  shape("sketch", "ellipse", 314, 112, 470, 212, { fill: "#ffec99" }),
  text("sketch-label", 358, 142, "Sketch"),
  shape("arrow-2", "arrow", 392, 222, 392, 288),
  shape("ship", "rectangle", 312, 300, 472, 372, { fill: "#b2f2bb" }),
  text("ship-label", 352, 318, "Ship it"),
  text("note", 64, 236, "talk to 5 users\nby Friday", 24, { stroke: "#5e6676" }),
  {
    id: "check",
    type: "pen",
    pressure: false,
    stroke: "#2f9e44",
    penSize: 5,
    points: [
      [190, 96, 0.5],
      [196, 104, 0.5],
      [202, 110, 0.5],
      [210, 96, 0.5],
      [220, 80, 0.5],
      [228, 70, 0.5],
    ],
  },
];

// A loose, slightly wobbly loop around "Ship it", drawn live by a collaborator.
export function circleStroke() {
  const points = [];
  const cx = 392;
  const cy = 336;
  const steps = 84;
  for (let i = 0; i <= steps; i += 1) {
    const t = i / steps;
    const angle = -2.4 + t * (Math.PI * 2 + 0.7);
    const wobble = 1 + 0.035 * Math.sin(angle * 3 + 1) + t * 0.05;
    points.push([cx + Math.cos(angle) * 112 * wobble, cy + Math.sin(angle) * 54 * wobble, 0.5]);
  }
  return points;
}

export const COLLABORATORS = [
  { name: "Maya", color: "#e8590c" },
  { name: "Sam", color: "#1971c2", rest: { x: 232, y: 96 } },
];
