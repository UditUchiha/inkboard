import type { ElementType, Font, Route } from "@inkboard/shared/types";

/** What the pointer does on the board. */
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
  | "comment";

/** A tool as the toolbar lists it: its name and the key that picks it. */
export type Tool = { id: ToolId; label: string; key: string };

/** A choice in a style control: what it is called and the value it sets. */
export type Choice<T = string> = { name: string; value: T };

/** What new elements are drawn with, and what the style controls change. */
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

/** The controls of the properties panel, each of which sets a field or two of the style. */
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
  | "name";

// Tools appear in the toolbar in this order; number keys 1–9 follow it too (the
// tools after the ninth have a letter only).
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

// Only offered to signed-in people who can edit the board. It has no number key.
export const COMMENT_TOOL: Tool = { id: "comment", label: "Comment", key: "c" };

// The board limit and the merge-rules version are the server's too (shared/src/limits.ts).
export { MAX_ELEMENTS_PER_BOARD, SYNC_FORMAT } from "@inkboard/shared/limits";

// A pen stroke longer than this carries on as a new one: each step of a stroke
// is sent whole, so the longer it gets the more every step costs.
export const STROKE_SPLIT_POINTS = 1000;

export const NUMBERED_TOOLS = 9;

export const DRAWING_TOOLS = new Set<ToolId>(["pen", "rectangle", "ellipse", "arrow", "line", "text", "sticky"]);
export const FILLABLE_TYPES = new Set<ElementType>(["rectangle", "ellipse"]);

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

// Frames are white pages on the board, named above their top left corner.
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

/** `font` if it names one of the FONTS, else the default (an element's font is whatever its author's file said). */
export const fontKey = (font: unknown): Font =>
  // The casts: `font` is whatever a file said, so it is looked up as a key and, if found, is a Font.
  Object.hasOwn(FONTS, font as PropertyKey) ? (font as Font) : "hand";

export const LINE_HEIGHT = 1.25;

// Labels typed on lines and arrows, in board units.
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

// Which style controls each element type exposes.
export const STYLE_CONTROLS: Record<ElementType, StyleControl[]> = {
  pen: ["stroke", "penSize"],
  line: ["stroke", "strokeWidth", "route", "sketchy", "labelFont"],
  arrow: ["stroke", "strokeWidth", "route", "startHead", "sketchy", "labelFont"],
  rectangle: ["stroke", "fill", "strokeWidth", "sketchy"],
  ellipse: ["stroke", "fill", "strokeWidth", "sketchy"],
  text: ["stroke", "font", "fontSize"],
  sticky: ["noteFill", "font"],
  frame: ["name"],
  image: [],
};

export const MIN_ZOOM = 0.1;
export const MAX_ZOOM = 6;
export const HIT_TOLERANCE = 6; // screen pixels
export const ERASER_RADIUS = 10; // screen pixels
export const GRID_SIZE = 24;
