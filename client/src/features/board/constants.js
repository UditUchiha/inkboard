// Tools appear in the toolbar in this order; number keys 1–9 follow it too.
export const TOOLS = [
  { id: "select", label: "Select and move", key: "v" },
  { id: "hand", label: "Pan", key: "h" },
  { id: "pen", label: "Pen", key: "p" },
  { id: "rectangle", label: "Rectangle", key: "r" },
  { id: "ellipse", label: "Ellipse", key: "o" },
  { id: "arrow", label: "Arrow", key: "a" },
  { id: "line", label: "Line", key: "l" },
  { id: "text", label: "Text", key: "t" },
  { id: "eraser", label: "Eraser", key: "e" },
];

// Only offered to signed-in people who can edit the board. It has no number key.
export const COMMENT_TOOL = { id: "comment", label: "Comment", key: "c" };

// The most elements a board can hold (the server's limit too).
export const MAX_ELEMENTS_PER_BOARD = 5000;

export const DRAWING_TOOLS = new Set(["pen", "rectangle", "ellipse", "arrow", "line", "text"]);
export const FILLABLE_TYPES = new Set(["rectangle", "ellipse"]);

export const STROKE_COLORS = [
  { name: "Ink", value: "#16213a" },
  { name: "Red", value: "#e03131" },
  { name: "Orange", value: "#f08c00" },
  { name: "Green", value: "#2f9e44" },
  { name: "Blue", value: "#1971c2" },
  { name: "Violet", value: "#7048e8" },
];

export const FILL_COLORS = [
  { name: "Rose", value: "#ffc9c9" },
  { name: "Butter", value: "#ffec99" },
  { name: "Mint", value: "#b2f2bb" },
  { name: "Sky", value: "#a5d8ff" },
  { name: "Lilac", value: "#d0bfff" },
];

export const STROKE_WIDTHS = [
  { name: "Thin", value: 1 },
  { name: "Regular", value: 2.5 },
  { name: "Bold", value: 4.5 },
];

export const PEN_SIZES = [
  { name: "Fine", value: 4 },
  { name: "Regular", value: 8 },
  { name: "Thick", value: 14 },
  { name: "Marker", value: 24 },
];

export const FONT_SIZES = [
  { name: "S", value: 20 },
  { name: "M", value: 32 },
  { name: "L", value: 48 },
  { name: "XL", value: 72 },
];

export const FONTS = {
  hand: { name: "Hand", family: '"Caveat Variable", cursive' },
  sans: { name: "Sans", family: '"Archivo Variable", sans-serif' },
  code: { name: "Code", family: '"JetBrains Mono Variable", monospace' },
};

export const LINE_HEIGHT = 1.25;

export const DEFAULT_STYLE = {
  stroke: STROKE_COLORS[0].value,
  fill: null,
  strokeWidth: 2.5,
  penSize: 8,
  sketchy: true,
  fontSize: 32,
  font: "hand",
};

// Which style controls each element type exposes.
export const STYLE_CONTROLS = {
  pen: ["stroke", "penSize"],
  line: ["stroke", "strokeWidth", "sketchy"],
  arrow: ["stroke", "strokeWidth", "sketchy"],
  rectangle: ["stroke", "fill", "strokeWidth", "sketchy"],
  ellipse: ["stroke", "fill", "strokeWidth", "sketchy"],
  text: ["stroke", "font", "fontSize"],
  image: [],
};

export const MIN_ZOOM = 0.1;
export const MAX_ZOOM = 6;
export const HIT_TOLERANCE = 6; // screen pixels
export const ERASER_RADIUS = 10; // screen pixels
export const GRID_SIZE = 24;
