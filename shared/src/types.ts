// The shapes the board rules pass around, so the browser and the server read an element, a stamp or an operation the
// same way. Types only; the rules are in board-merge.ts, board-order.ts and element-rules.ts.

export type Font = "hand" | "sans" | "code";

export type Side = "top" | "right" | "bottom" | "left";

export type Route = "straight" | "curved" | "elbow";

export type Point = [x: number, y: number, pressure: number];

export type StackMove = "front" | "forward" | "backward" | "back";

export type Stamp = { version: number; versionNonce: number };

export type StampPair = [version: number, versionNonce: number];

export type MaybeStamped = { version?: unknown; versionNonce?: unknown };

export type FieldGroup =
  | "shape"
  | "text"
  | "stroke"
  | "fill"
  | "strokeWidth"
  | "penSize"
  | "sketchy"
  | "font"
  | "name"
  | "route"
  | "startHead"
  | "index";

export type ElementStamps = Partial<Record<FieldGroup, StampPair>>;

export type GroupStamps = Partial<Record<FieldGroup, Stamp>>;

export type Fields = { id: string; [field: string]: unknown };

export type TextField = "text" | "name" | "alt";

// the first `prefix` and last `suffix` characters are the same, and `middle` was between them (see text-merge.ts)
export type Splice = [prefix: number, suffix: number, middle: string];

export type TextBases = Partial<Record<TextField, Splice>>;

// `base` is only on a change on its way to a board, never on an element a board keeps (see text-merge.ts); stamps are
// missing on an element from an older browser
type Common = Partial<Stamp> & { id: string; index?: string; stamps?: ElementStamps; base?: TextBases };

export type PenElement = Common & {
  type: "pen";
  points: Point[];
  pressure: boolean;
  stroke: string;
  penSize: number;
  angle?: number;
};

export type TextElement = Common & {
  type: "text";
  x1: number;
  y1: number;
  text: string;
  stroke: string;
  fontSize: number;
  font: Font;
  angle?: number;
};

export type StickyElement = Common & {
  type: "sticky";
  x1: number;
  y1: number;
  x2: number;
  y2: number;
  text: string;
  fill: string;
  font: Font;
  angle?: number;
};

export type FrameElement = Common & {
  type: "frame";
  x1: number;
  y1: number;
  x2: number;
  y2: number;
  name: string;
};

export type ImageCrop = { x: number; y: number; w: number; h: number };

/**
 * A picture, kept by the server under `imageId`. `crop` is the part of it shown in the box (all of it when left out),
 * and `alt` says what it shows, for people who can't see it.
 */
export type ImageElement = Common & {
  type: "image";
  imageId: string;
  x1: number;
  y1: number;
  x2: number;
  y2: number;
  crop?: ImageCrop;
  alt?: string;
  angle?: number;
};

export type ConnectorFields = {
  startId?: string;
  endId?: string;
  startAnchor?: Side;
  endAnchor?: Side;
  route?: Route;
  startHead?: boolean;
  text?: string;
  font?: Font;
};

// One kind because they share geometry and look and merge the same way. Only a line or arrow has the connector fields
// and an unfillable (null) fill. A triangle points up from its base along the bottom of its box; a diamond's corners
// are the middles of its box's sides.
export type ShapeElement = Common &
  ConnectorFields & {
    type: "line" | "arrow" | "rectangle" | "ellipse" | "triangle" | "diamond";
    seed: number;
    x1: number;
    y1: number;
    x2: number;
    y2: number;
    stroke: string;
    fill: string | null;
    strokeWidth: number;
    sketchy: boolean;
    angle?: number;
  };

export type Element = PenElement | TextElement | StickyElement | FrameElement | ImageElement | ShapeElement;

export type ElementType = Element["type"];

export type TurnableType = Exclude<ElementType, "frame" | "line" | "arrow">;

/** The removal of an element. It has a stamp unless it came from an older browser, which sends a bare id instead. */
export type Removal = { id: string } & Partial<Stamp>;

export type Operation = { upsert?: readonly Element[]; remove?: readonly (Removal | string)[] };

/** What a removal leaves behind: its stamp and the element's last data, so later changes can still merge into it. */
export type Tombstone = Stamp & { element?: Element | undefined };

export type Tombstones = Map<string, Tombstone>;

export type LiveElements = {
  get(id: string): Element | undefined;
  set(id: string, element: Element): unknown;
  delete(id: string): unknown;
  settle?(): void;
};

export type Plan = {
  elements: Element[];
  live: LiveElements;
  shown: Map<string, Element>;
  buried: Map<string, Element>;
  hidden: Map<string, Stamp>;
  graves: Map<string, Tombstone | null>;
  added: Set<string>;
};

export type Effect = { upsert: Element[]; remove: ({ id: string } & Stamp)[] };

export type PlanOptions = {
  index?: Map<string, Element> | null;
  // Whether a removal of an element nobody has seen is remembered.
  remember?: boolean;
};

export type CommitOptions = {
  limit?: number;
};

export type CommitResult = { elements: Element[]; dropped: string[] };
