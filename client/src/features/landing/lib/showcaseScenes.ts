import type { FrameElement, ShapeElement, StickyElement, TextElement } from "@inkboard/shared/types";
import { arcPoints, polyline, wobbly } from "./showcase";
import type { Person, Scene, Step } from "./showcase";

const INK = "#16213a";
const SOFT = "#5e6676";

export const MAYA: Person = { name: "Maya", color: "#c2410c" };
export const SAM: Person = { name: "Sam", color: "#1971c2" };
const AVA: Person = { name: "Ava", color: "#c2410c" };
const BEN: Person = { name: "Ben", color: "#1971c2" };
const CHEN: Person = { name: "Chen", color: "#2f9e44" };

const shape = (
  id: string,
  type: ShapeElement["type"],
  x1: number,
  y1: number,
  x2: number,
  y2: number,
  fill: string | null = null,
): ShapeElement => ({
  id,
  type,
  seed: id.length * 7919 + x1,
  x1,
  y1,
  x2,
  y2,
  stroke: INK,
  fill,
  strokeWidth: 2,
  sketchy: true,
});

const text = (id: string, x1: number, y1: number, value: string, fontSize = 22, stroke = INK): TextElement => ({
  id,
  type: "text",
  x1,
  y1,
  text: value,
  stroke,
  fontSize,
  font: "hand",
});

const sticky = (id: string, x1: number, y1: number, value: string, fill: string): StickyElement => ({
  id,
  type: "sticky",
  x1,
  y1,
  x2: x1 + 150,
  y2: y1 + 90,
  text: value,
  fill,
  font: "hand",
});

const frame = (id: string, x1: number, y1: number, x2: number, y2: number, name: string): FrameElement => ({
  id,
  type: "frame",
  x1,
  y1,
  x2,
  y2,
  name,
});

// A box and its caption appear together.
const labelled = (at: number, box: ShapeElement, label: string, dx: number): Step[] => [
  { at, add: box },
  { at, add: text(`${box.id}-label`, box.x1 + dx, (box.y1 + box.y2) / 2 - 14, label) },
];

// One step every beat, so the drawing visibly builds up as an answer streams in.
const BEAT = 420;

export type Prompt = { prompt: string; scene: Scene };

export const AI_PROMPTS: Prompt[] = [
  {
    prompt: "A signup flow with email verification",
    scene: {
      duration: BEAT * 8,
      steps: [
        ...labelled(0, shape("signup", "rectangle", 36, 165, 166, 235, "#a5d8ff"), "Sign up", 28),
        { at: BEAT, add: shape("a1", "arrow", 178, 200, 228, 200) },
        ...labelled(BEAT * 2, shape("email", "rectangle", 240, 165, 384, 235, "#a5d8ff"), "Send email", 20),
        { at: BEAT * 3, add: shape("a2", "arrow", 396, 200, 446, 200) },
        ...labelled(BEAT * 4, shape("verified", "diamond", 458, 145, 604, 255, "#ffec99"), "Verified?", 30),
        { at: BEAT * 5, add: shape("a3", "arrow", 531, 267, 531, 305) },
        { at: BEAT * 5, add: text("yes", 540, 268, "yes", 18, SOFT) },
        ...labelled(BEAT * 6, shape("dash", "rectangle", 456, 318, 606, 380, "#b2f2bb"), "Dashboard", 22),
        { at: BEAT * 7, add: shape("a4", "arrow", 531, 133, 531, 95) },
        { at: BEAT * 7, add: text("no", 540, 98, "no", 18, SOFT) },
        ...labelled(BEAT * 7, shape("resend", "rectangle", 456, 24, 606, 84), "Resend link", 18),
      ],
    },
  },
  {
    prompt: "A retro board with three columns",
    scene: {
      duration: BEAT * 7,
      steps: [
        { at: 0, add: frame("went", 24, 36, 216, 376, "Went well") },
        { at: 0, add: frame("improve", 224, 36, 416, 376, "To improve") },
        { at: 0, add: frame("actions", 424, 36, 616, 376, "Actions") },
        { at: BEAT, add: sticky("s1", 44, 70, "Shipped on time", "#b2f2bb") },
        { at: BEAT * 2, add: sticky("s2", 244, 70, "Too many meetings", "#ffc9c9") },
        { at: BEAT * 3, add: sticky("s3", 44, 180, "Pairing worked", "#b2f2bb") },
        { at: BEAT * 4, add: sticky("s4", 444, 70, "Meeting-free Wednesdays", "#ffec99") },
        { at: BEAT * 5, add: sticky("s5", 244, 180, "Late design handoff", "#ffc9c9") },
        { at: BEAT * 6, add: sticky("s6", 444, 180, "Design review on Monday", "#ffec99") },
      ],
    },
  },
  {
    prompt: "Browser, API and database, with a cache",
    scene: {
      duration: BEAT * 7,
      steps: [
        ...labelled(0, shape("browser", "rectangle", 36, 150, 176, 220, "#a5d8ff"), "Browser", 32),
        { at: BEAT, add: shape("b1", "arrow", 188, 185, 238, 185) },
        ...labelled(BEAT * 2, shape("api", "rectangle", 250, 150, 390, 220, "#ffec99"), "API", 52),
        { at: BEAT * 3, add: shape("b2", "arrow", 402, 185, 452, 185) },
        ...labelled(BEAT * 4, shape("db", "ellipse", 464, 130, 614, 240, "#b2f2bb"), "Database", 30),
        { at: BEAT * 5, add: shape("b3", "arrow", 320, 232, 320, 282) },
        ...labelled(BEAT * 6, shape("cache", "ellipse", 250, 294, 390, 374, "#e5dbff"), "Cache", 42),
      ],
    },
  },
];

export const SUGGEST_SCENE: Scene = {
  duration: 4200,
  steps: [
    ...labelled(0, shape("idea", "rectangle", 36, 150, 170, 220, "#a5d8ff"), "Idea", 42),
    { at: 0, add: shape("i1", "arrow", 182, 185, 224, 185) },
    ...labelled(0, shape("proto", "rectangle", 236, 150, 400, 220, "#a5d8ff"), "Prototype", 36),
    { at: 0, add: shape("i2", "arrow", 412, 185, 454, 185) },
    ...labelled(0, shape("launch", "rectangle", 466, 150, 604, 220, "#b2f2bb"), "Launch", 32),
    { at: 400, cursor: { by: MAYA, x: 330, y: 330 } },
    { at: 1000, suggest: shape("test", "rectangle", 236, 272, 400, 340, "#ffec99"), by: MAYA },
    { at: 1000, suggest: text("test-label", 268, 292, "User test"), by: MAYA },
    { at: 1300, suggest: shape("i3", "arrow", 318, 232, 318, 260), by: MAYA },
    { at: 1300, note: "Maya suggested a step. Nothing has changed yet." },
    { at: 2200, cursor: { by: SAM, x: 560, y: 300 } },
    { at: 3000, cursor: { by: SAM, x: 410, y: 300 } },
    { at: 3400, accept: "test" },
    { at: 3400, accept: "test-label" },
    { at: 3400, accept: "i3" },
    { at: 3400, note: "You accepted it. Now it's on everyone's board." },
  ],
};

const house = wobbly(
  [
    [60, 300],
    [60, 210],
    [120, 150],
    [180, 210],
    [180, 300],
    [60, 300],
  ],
  1.5,
  2,
);
const sun = wobbly(arcPoints(320, 230, 48, 48, 0, Math.PI * 2 + 0.4, 40), 1.4, 3);
const wave = wobbly(
  Array.from({ length: 36 }, (_, i): [number, number] => [450 + i * 4.3, 240 + Math.sin(i / 2.6) * 34]),
  1,
  4,
);

export const CLASSROOM_SCENE: Scene = {
  duration: 4200,
  steps: [
    { at: 0, add: frame("seat-1", 24, 40, 216, 376, "Seat 1") },
    { at: 0, add: frame("seat-2", 224, 40, 416, 376, "Seat 2") },
    { at: 0, add: frame("seat-3", 424, 40, 616, 376, "Seat 3") },
    { at: 300, claim: { frameId: "seat-1", by: AVA } },
    { at: 500, claim: { frameId: "seat-2", by: BEN } },
    { at: 700, claim: { frameId: "seat-3", by: CHEN } },
    { at: 700, note: "Each student claims a frame and can draw only there." },
    { at: 900, stroke: polyline("ava", AVA.color, house, 4), over: 2000, by: AVA },
    { at: 1300, stroke: polyline("ben", BEN.color, sun, 4), over: 1800, by: BEN },
    { at: 1700, stroke: polyline("chen", CHEN.color, wave, 4), over: 1800, by: CHEN },
    { at: 3600, note: "The teacher sees all of them live and can copy a frame to the class." },
  ],
};

const PEN = 5;
// "E = mc²", one or two strokes per glyph, as a pen would write it.
const handwriting = [
  polyline(
    "e1",
    INK,
    wobbly(
      [
        [206, 150],
        [152, 152],
        [150, 250],
        [208, 250],
      ],
      1.5,
      5,
    ),
    PEN,
  ),
  polyline(
    "e2",
    INK,
    wobbly(
      [
        [152, 200],
        [196, 198],
      ],
      1,
      6,
    ),
    PEN,
  ),
  polyline(
    "eq1",
    INK,
    wobbly(
      [
        [244, 194],
        [292, 192],
      ],
      1,
      7,
    ),
    PEN,
  ),
  polyline(
    "eq2",
    INK,
    wobbly(
      [
        [244, 214],
        [292, 213],
      ],
      1,
      8,
    ),
    PEN,
  ),
  polyline(
    "m",
    INK,
    wobbly(
      [
        [326, 250],
        [326, 210],
        [331, 200],
        [341, 203],
        [349, 215],
        [351, 250],
        [351, 215],
        [359, 202],
        [369, 204],
        [377, 216],
        [379, 250],
      ],
      1.2,
      9,
    ),
    PEN,
  ),
  polyline("c", INK, wobbly(arcPoints(430, 228, 24, 24, -0.8, -5.5, 24), 1, 10), PEN),
  polyline(
    "sq",
    INK,
    wobbly([...arcPoints(474, 187, 7, 7, Math.PI, Math.PI * 2 + 0.3, 10), [481, 197], [466, 200], [484, 200]], 0.6, 11),
    3,
  ),
];

export const EQUATION_SCENE: Scene = {
  duration: 5200,
  steps: [
    ...handwriting.map((stroke, i): Step => ({ at: 200 + i * 380, stroke, over: 340, by: MAYA })),
    { at: 3000, cursor: { by: MAYA, x: 530, y: 300 } },
    { at: 3200, note: "Select the strokes, then Convert to equation." },
    ...handwriting.map((stroke): Step => ({ at: 4300, remove: stroke.id })),
    { at: 4300, add: { ...text("tex", 150, 150, "$$E = mc^2$$", 72), font: "sans" } },
    { at: 4300, note: "Typeset as LaTeX. Edit the formula any time." },
  ],
};
