import type { ElementType, Font, Route } from "@inkboard/shared/types";

export type ToolId =
  | "select"
  | "hand"
  | "pen"
  | "rectangle"
  | "ellipse"
  | "arrow"
  | "line"
  | "text"
  | "sticky"
  | "frame"
  | "eraser"
  | "comment"
  // Only while a round of dot voting is open.
  | "vote";

export type Tool = { id: ToolId; label: string; key: string };

export type Choice<T = string> = { name: string; value: T };

export type Style = {
  stroke: string;
  fill: string | null;
  strokeWidth: number;
  penSize: number;
  sketchy: boolean;
  fontSize: number;
  font: Font;
  noteFill: string;
  route: Route;
  startHead: boolean;
};

export type StyleControl =
  | "stroke"
  | "fill"
  | "strokeWidth"
  | "penSize"
  | "sketchy"
  | "route"
  | "startHead"
  | "labelFont"
  | "font"
  | "fontSize"
  | "noteFill"
  | "name"
  | "crop"
  | "alt";

// Toolbar order; number keys 1–9 follow it (later tools have a letter only).
export const TOOLS: Tool[] = [
  { id: "select", label: "Select and move", key: "v" },
  { id: "hand", label: "Pan", key: "h" },
  { id: "pen", label: "Pen", key: "p" },
  { id: "rectangle", label: "Rectangle", key: "r" },
  { id: "ellipse", label: "Ellipse", key: "o" },
  { id: "arrow", label: "Arrow", key: "a" },
  { id: "line", label: "Line", key: "l" },
  { id: "text", label: "Text", key: "t" },
  { id: "sticky", label: "Sticky note", key: "s" },
  { id: "frame", label: "Frame", key: "f" },
  { id: "eraser", label: "Eraser", key: "e" },
];

// Only for signed-in people who can edit; no number key.
export const COMMENT_TOOL: Tool = { id: "comment", label: "Comment", key: "c" };

// The board limit and the merge-rules version are the server's too (shared/src/limits.ts).
export { MAX_ELEMENTS_PER_BOARD, SYNC_FORMAT } from "@inkboard/shared/limits";

// A pen stroke past this carries on as a new one: each step is sent whole, so cost grows with length.
export const STROKE_SPLIT_POINTS = 1000;

export const NUMBERED_TOOLS = 9;

export const DRAWING_TOOLS = new Set<ToolId>(["pen", "rectangle", "ellipse", "arrow", "line", "text", "sticky"]);
export const FILLABLE_TYPES = new Set<ElementType>(["rectangle", "ellipse", "triangle", "diamond"]);

export const STROKE_COLORS: Choice[] = [
  { name: "Ink", value: "#16213a" },
  { name: "Red", value: "#e03131" },
  { name: "Orange", value: "#f08c00" },
  { name: "Green", value: "#2f9e44" },
  { name: "Blue", value: "#1971c2" },
  { name: "Violet", value: "#7048e8" },
];

export const FILL_COLORS: Choice[] = [
  { name: "Rose", value: "#ffc9c9" },
  { name: "Butter", value: "#ffec99" },
  { name: "Mint", value: "#b2f2bb" },
  { name: "Sky", value: "#a5d8ff" },
  { name: "Lilac", value: "#d0bfff" },
];

// Sticky notes come in the fill colors, plus a warmer orange. Butter is the default.
export const NOTE_COLORS: Choice[] = [
  FILL_COLORS[1],
  { name: "Peach", value: "#ffd8a8" },
  ...FILL_COLORS.filter((_, i) => i !== 1),
];
export const NOTE_TEXT_COLOR = "#16213a";
export const NOTE_SIZE = 200; // a new note's side, in board units

export const FRAME_FILL = "#ffffff";
export const FRAME_BORDER = "#c3c8d2";
export const FRAME_LABEL_COLOR = "#5e6676";
export const FRAME_LABEL_SIZE = 13; // screen pixels in the editor, board units in exports and thumbnails
export const FRAME_LABEL_GAP = 6;

export const STROKE_WIDTHS: Choice<number>[] = [
  { name: "Thin", value: 1 },
  { name: "Regular", value: 2.5 },
  { name: "Bold", value: 4.5 },
];

export const PEN_SIZES: Choice<number>[] = [
  { name: "Fine", value: 4 },
  { name: "Regular", value: 8 },
  { name: "Thick", value: 14 },
  { name: "Marker", value: 24 },
];

export const FONT_SIZES: Choice<number>[] = [
  { name: "S", value: 20 },
  { name: "M", value: 32 },
  { name: "L", value: 48 },
  { name: "XL", value: 72 },
];

export const FONTS: Record<Font, { name: string; family: string }> = {
  hand: { name: "Hand", family: '"Caveat Variable", cursive' },
  sans: { name: "Sans", family: '"Archivo Variable", sans-serif' },
  code: { name: "Code", family: '"JetBrains Mono Variable", monospace' },
};

// An element's font is whatever its file said, so an unknown one falls back to the default.
export const fontKey = (font: unknown): Font =>
  // the casts: `font` comes from a file, so it is looked up as a key
  Object.hasOwn(FONTS, font as PropertyKey) ? (font as Font) : "hand";

export const LINE_HEIGHT = 1.25;

export const LABEL_FONT_SIZE = 20;
export const LABEL_PADDING = 4; // the gap the line leaves around its label

export const ROUTE_OPTIONS: Choice<Route>[] = [
  { name: "Straight", value: "straight" },
  { name: "Curved", value: "curved" },
  { name: "Elbow", value: "elbow" },
];

export const DEFAULT_STYLE: Style = {
  stroke: STROKE_COLORS[0].value,
  fill: null,
  strokeWidth: 2.5,
  penSize: 8,
  sketchy: true,
  fontSize: 32,
  font: "hand",
  noteFill: NOTE_COLORS[0].value,
  route: "straight",
  startHead: false,
};

export const STYLE_CONTROLS: Record<ElementType, StyleControl[]> = {
  pen: ["stroke", "penSize"],
  line: ["stroke", "strokeWidth", "route", "sketchy", "labelFont"],
  arrow: ["stroke", "strokeWidth", "route", "startHead", "sketchy", "labelFont"],
  rectangle: ["stroke", "fill", "strokeWidth", "sketchy"],
  ellipse: ["stroke", "fill", "strokeWidth", "sketchy"],
  triangle: ["stroke", "fill", "strokeWidth", "sketchy"],
  diamond: ["stroke", "fill", "strokeWidth", "sketchy"],
  text: ["stroke", "font", "fontSize"],
  sticky: ["noteFill", "font"],
  frame: ["name"],
  image: ["crop", "alt"],
};

export const MIN_ZOOM = 0.1;
export const MAX_ZOOM = 6;
export const HIT_TOLERANCE = 6; // screen pixels
export const ERASER_RADIUS = 10; // screen pixels
export const GRID_SIZE = 24;
