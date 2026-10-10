// The shapes of the things the board rules pass around. They live in one place so the browser and the
// server read an element, a stamp or an operation the same way. This file holds types only, so it adds
// nothing at run time; the rules that act on them are in board-merge.ts, board-order.ts and element-rules.ts.

/** A font a piece of text can be drawn in. */
export type Font = "hand" | "sans" | "code";

/** A side of a shape that a connector can be pinned to. */
export type Side = "top" | "right" | "bottom" | "left";

/** How a connector runs between its ends. */
export type Route = "straight" | "curved" | "elbow";

/** One point of a pen stroke: x, y and the pressure (0 to 1) it was drawn with. */
export type Point = [x: number, y: number, pressure: number];

/** Where an element can be moved in the stack (see keyToMove in board-order.ts). */
export type StackMove = "front" | "forward" | "backward" | "back";

/** The stamp of one change: a version and a random nonce (see board-merge.ts). */
export type Stamp = { version: number; versionNonce: number };

/** A stamp as an element lists it for a property group that is older than its newest: [version, nonce]. */
export type StampPair = [version: number, versionNonce: number];

/** What something that may carry a stamp looks like before it has been checked: any part can be missing or wrong. */
export type MaybeStamped = { version?: unknown; versionNonce?: unknown };

/** The property groups of an element, each stamped on its own (see FIELD_GROUPS in board-merge.ts). */
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

/** The older stamps an element lists, by group (its newest is `version` / `versionNonce`). */
export type ElementStamps = Partial<Record<FieldGroup, StampPair>>;

/** The stamp of each group of an element, by group. */
export type GroupStamps = Partial<Record<FieldGroup, Stamp>>;

/** An element's fields looked at loosely, for code that handles them by name (copying a group, say). */
export type Fields = { id: string; [field: string]: unknown };

// What every element has, whatever it is: its id, where it sits in the stack, and its stamps. The
// stamps are missing on an element from an older browser.
type Common = Partial<Stamp> & { id: string; index?: string; stamps?: ElementStamps };

/** A freehand stroke. */
export type PenElement = Common & {
  type: "pen";
  points: Point[];
  pressure: boolean;
  stroke: string;
  penSize: number;
  angle?: number;
};

/** Text drawn at a point. */
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

/** A sticky note. */
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

/** A named frame that groups what's drawn inside it. */
export type FrameElement = Common & {
  type: "frame";
  x1: number;
  y1: number;
  x2: number;
  y2: number;
  name: string;
};

/** A picture, kept by the server under `imageId`. */
export type ImageElement = Common & {
  type: "image";
  imageId: string;
  x1: number;
  y1: number;
  x2: number;
  y2: number;
  angle?: number;
};

/** What a line or arrow has beyond its shape: what its ends are attached to, its route, a label and its font. */
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

/**
 * A line, arrow, rectangle or ellipse. They are one kind here because they share their geometry and look
 * and merge the same way. Only a rectangle or ellipse can be filled (it's null on the others, and they
 * can't be turned), and only a line or arrow has the connector fields: the elements its ends are
 * attached to, a route, a label and its font, and for an arrow an arrowhead at the start.
 */
export type ShapeElement = Common &
  ConnectorFields & {
    type: "line" | "arrow" | "rectangle" | "ellipse";
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

/** Anything that can be on a board, told apart by its `type`. */
export type Element = PenElement | TextElement | StickyElement | FrameElement | ImageElement | ShapeElement;

/** The kinds of element there are. */
export type ElementType = Element["type"];

/** The kinds of element that can be turned (they have an `angle`). */
export type TurnableType = Exclude<ElementType, "frame" | "line" | "arrow">;

/** The removal of an element. It has a stamp unless it came from an older browser, which sends a bare id instead. */
export type Removal = { id: string } & Partial<Stamp>;

/** A change to a board: elements added or changed, and elements removed (a removal may be a bare id). */
export type Operation = { upsert?: readonly Element[]; remove?: readonly (Removal | string)[] };

/** What a removal leaves behind: its stamp and the element's last data, so later changes can still merge into it. */
export type Tombstone = Stamp & { element?: Element | undefined };

/** The tombstones of a board, by the id of the element removed. */
export type Tombstones = Map<string, Tombstone>;

/** The elements by id as a plan sees them. A plain Map does, or an overlay on the board's own index. */
export type LiveElements = {
  get(id: string): Element | undefined;
  set(id: string, element: Element): unknown;
  delete(id: string): unknown;
  // Only an overlay has this: it writes the plan's changes into the index it is laid over.
  settle?(): void;
};

/** What an operation would do to a board, worked out by planOperation without changing anything. */
export type Plan = {
  // The board's elements as they were.
  elements: Element[];
  // Every element visible afterwards, by id.
  live: LiveElements;
  // Elements added or changed, as they now are.
  shown: Map<string, Element>;
  // Removed elements whose remembered data changed, as it now is.
  buried: Map<string, Element>;
  // Removals that took effect, by id, with their stamps.
  hidden: Map<string, Stamp>;
  // Tombstones to set, or null to clear.
  graves: Map<string, Tombstone | null>;
  // Ids of elements that weren't on the board before.
  added: Set<string>;
};

/** What a plan changed, as an operation to pass on to everyone else: every removal carries its stamp. */
export type Effect = { upsert: Element[]; remove: ({ id: string } & Stamp)[] };

/** Options for planOperation. */
export type PlanOptions = {
  // A Map of the board's elements by id that the caller keeps up to date, which saves building one.
  index?: Map<string, Element> | null;
  // Whether a removal of an element nobody has seen is remembered.
  remember?: boolean;
};

/** Options for commitPlan. */
export type CommitOptions = {
  // The most elements to keep: new ones past it are dropped.
  limit?: number;
};

/** What commitPlan returns: the board's new elements, sorted, and the ids of new ones dropped for lack of room. */
export type CommitResult = { elements: Element[]; dropped: string[] };
