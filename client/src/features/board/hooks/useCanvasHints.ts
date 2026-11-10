import type { Side } from "@inkboard/shared/types";
import { useState } from "react";
import type { RefObject } from "react";
import { HIT_TOLERANCE } from "../constants/board";
import type { ToolId } from "../constants/board";
import { canChange } from "../lib/elements/classroom";
import { connectionAt, dotBeatsHandle, dotGrab, dotHover, drawnElement } from "../lib/elements/connectors";
import type { Connectable } from "../lib/elements/connectors";
import { elementAt } from "../lib/elements/elements";
import type { Viewport, XY } from "../lib/elements/geometry";
import { handleAt } from "../lib/elements/transform";
import type { BoardStore } from "../lib/sync/store";
import type { Latest, Under } from "./useGestureLifecycle";

// For connecting: the shape a connector end would attach to (`outline`) and the one whose dots to show (`dots`).
export type Hint = { outline: string | null; dots: { id: string; side: Side | null } | null };
export const NO_HINT: Hint = { outline: null, dots: null };
const sameHint = (a: Hint, b: Hint) =>
  a.outline === b.outline && a.dots?.id === b.dots?.id && (a.dots?.side ?? null) === (b.dots?.side ?? null);
const ARROW_TOOLS = new Set<ToolId>(["arrow", "line"]);

// What's under the pointer: the element, the connection to attach to, the handle or dot to grab.
export function useCanvasHints(store: BoardStore, latest: RefObject<Latest>, tool: ToolId) {
  const [hint, setHint] = useState(NO_HINT); // see NO_HINT
  const showHint = (next: Hint) => setHint((current) => (sameHint(current, next) ? current : next));

  // Dots shown for a tool that's been put away would only get in the way.
  const [hintTool, setHintTool] = useState(tool);
  if (tool !== hintTool) {
    setHintTool(tool);
    setHint(NO_HINT);
  }

  // Includes frame names (sized on screen); in classroom mode only what a student may change.
  const pick = (world: XY, vp: Viewport) => {
    const hit = elementAt(store.getElements(), world.x, world.y, HIT_TOLERANCE / vp.zoom, { labelScale: 1 / vp.zoom });
    return hit && canChange(hit, latest.current.zone) ? hit : null;
  };

  const connectionUnder = (world: XY, vp: Viewport, except?: string) =>
    connectionAt(store.getElements(), world, { zoom: vp.zoom, tolerance: HIT_TOLERANCE / vp.zoom, except });

  function connectAt(world: XY, vp: Viewport, except?: string) {
    const found = connectionUnder(world, vp, except);
    const id = found.target?.id ?? null;
    // The cast: `id &&` gives "" for an empty id, which no element has.
    showHint({ outline: id, dots: (id && { id, side: found.side }) as Hint["dots"] });
    return found;
  }

  // Looked up once and passed along: a pointer move needs both several times over.
  const lookUnder = (world: XY, vp: Viewport) => ({ found: connectionUnder(world, vp), hit: pick(world, vp) });

  const dotUnder = (world: XY, vp: Viewport, under?: Under) =>
    dotGrab(store.getElements(), world, { zoom: vp.zoom, tolerance: HIT_TOLERANCE / vp.zoom, ...under });

  const drawnSelected = () => {
    const id = latest.current.selectedId;
    return id ? drawnElement(store.getElements(), id) : null;
  };

  // A handle or a connection dot, never both (see dotBeatsHandle): the selected shape has handles where its dots would
  // be.
  function selectPress(world: XY, vp: Viewport, under?: Under) {
    const selected = drawnSelected();
    const handle = selected ? handleAt(selected, world, vp.zoom) : null;
    let grab = dotUnder(world, vp, under);
    if (grab?.target.id === latest.current.selectedId) grab = null;
    // The assertion: it only looks at `selected` when there is a handle, which is one of the selected element's.
    if (dotBeatsHandle(selected!, handle, grab, world, vp.zoom)) return { selected, handle: null, grab };
    return { selected, handle, grab: handle ? null : grab };
  }

  // Dots for the select tool and connector tools; the selected shape has its own handles there instead.
  function hoverDots(world: XY, vp: Viewport, under?: Under) {
    const { tool: activeTool, selectedId: selection } = latest.current;
    let found: { target: Connectable | null; side: Side | null } | null = null;
    const options = { zoom: vp.zoom, tolerance: HIT_TOLERANCE / vp.zoom, ...under };
    if (activeTool === "select") found = dotHover(store.getElements(), world, options);
    else if (ARROW_TOOLS.has(activeTool)) found = connectionUnder(world, vp);
    const id = found?.target?.id;
    if (!id || (activeTool === "select" && id === selection)) showHint(NO_HINT);
    // The assertion: there is an id only if something was found.
    else showHint({ outline: null, dots: { id, side: found!.side } });
  }

  return { hint, setHint, showHint, pick, connectAt, lookUnder, selectPress, hoverDots };
}
