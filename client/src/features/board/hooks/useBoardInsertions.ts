import type { Element as BoardElement, TextElement } from "@inkboard/shared/types";
import { toast } from "sonner";
import type { TextEdit } from "../components/BoardCanvas";
import type { Style, ToolId } from "../constants/board";
import { CLAIM_FIRST, CLASSROOM_TOAST, MERMAID_GAP } from "../constants/editor";
import type { Zone } from "../lib/elements/classroom";
import {
  createElement,
  createNote,
  getBounds,
  getSceneBounds,
  placedElement,
  translate,
} from "../lib/elements/elements";
import { fitViewport, rectContains, rectsOverlap, unionRects } from "../lib/elements/geometry";
import type { Rect, Size, Viewport } from "../lib/elements/geometry";
import { placeFree } from "../lib/elements/placement";
import { describeSkipped } from "../lib/mermaid/mermaid";
import type { BoardStore } from "../lib/sync/store";

interface InsertionOptions {
  store: BoardStore;
  zone: Zone;
  tool: ToolId;
  style: Style;
  zoom: number;
  canvasSize: Size;
  changeViewport: (next: Viewport) => void;
  visibleArea: () => Rect;
  setEditing: (edit: TextEdit) => void;
  selectElement: (id: string) => void;
  keepInZone: <T extends BoardElement>(element: T) => T | null;
  toastWithUndo: (message: string) => void;
}

export function useBoardInsertions({
  store,
  zone,
  tool,
  style,
  zoom,
  canvasSize,
  changeViewport,
  visibleArea,
  setEditing,
  selectElement,
  keepInZone,
  toastWithUndo,
}: InsertionOptions) {
  // An equation is a text written as $$…$$ (see math.ts).
  function addEquation() {
    const view = visibleArea();
    // The cast: createElement makes a text when asked for one.
    const centre = { x: view.x + view.width / 2, y: view.y + view.height / 2 };
    const element = createElement("text", centre, style) as TextElement;
    setEditing({ element: { ...element, text: "$$  $$" }, isNew: true });
  }

  // Enter with a drawing tool draws without a pointer: a shape is selected to move with the arrows, a text or note opened.
  function placeWithTool() {
    if (zone === null || (zone && tool === "frame")) {
      toast(zone ? "In classroom mode, frames are the teacher's." : CLAIM_FIRST, { id: CLASSROOM_TOAST });
      return;
    }
    const view = visibleArea();
    const centre = zone
      ? { x: (zone.x1 + zone.x2) / 2, y: (zone.y1 + zone.y2) / 2 }
      : { x: view.x + view.width / 2, y: view.y + view.height / 2 };
    if (tool === "text") setEditing({ element: createElement("text", centre, style), isNew: true });
    else if (tool === "sticky") {
      const note = keepInZone(placeFree(store.getElements(), createNote(centre, style)));
      if (note) setEditing({ element: note, isNew: true });
    } else if (tool === "rectangle" || tool === "ellipse" || tool === "line" || tool === "arrow" || tool === "frame") {
      const element = keepInZone(
        placeFree(store.getElements(), placedElement(tool, centre, style, store.getElements())),
      );
      if (!element) return;
      store.commit({ undo: { remove: [element.id] }, redo: { upsert: [element] } });
      selectElement(element.id);
    }
  }

  // Elements made all at once (Claude, Mermaid): one undo step, scrolled into view if not all on screen, with an undo message.
  function addDrawing(drawn: BoardElement[], message: string) {
    const before = drawn.flatMap((element) => store.getElement(element.id) ?? []);
    const added = drawn.filter((element) => !store.getElement(element.id)).map((element) => element.id);
    store.commit({ undo: { upsert: before, remove: added }, redo: { upsert: drawn } });
    const bounds = unionRects(drawn.map(getBounds));
    const view = visibleArea();
    const inView = (x: number, y: number) => rectContains(view, x, y);
    if (bounds && !(inView(bounds.x, bounds.y) && inView(bounds.x + bounds.width, bounds.y + bounds.height))) {
      changeViewport(fitViewport(bounds, canvasSize, { padding: 96, maxZoom: zoom }));
    }
    toastWithUndo(message);
  }
  const counted = (count: number) => `${count} ${count === 1 ? "element" : "elements"}`;
  const addAiDrawing = (drawn: BoardElement[], skipped: number) =>
    addDrawing(drawn, `Drew ${counted(drawn.length)}${skipped > 0 ? `; ${skipped} couldn't be drawn` : ""}`);
  // Goes in the middle of the screen, or beside everything if it would cover something.
  const addMermaid = (diagram: BoardElement[], skipped: string[]) => {
    const area = unionRects(diagram.map(getBounds))!;
    const board = store.getElements();
    const covers = board.some((element) => rectsOverlap(getBounds(element), area));
    const scene = getSceneBounds(board);
    const drawn =
      covers && scene
        ? diagram.map((element) => translate(element, scene.x + scene.width + MERMAID_GAP - area.x, 0))
        : diagram;
    addDrawing(drawn, `Imported ${counted(drawn.length)}${skipped.length > 0 ? `; ${describeSkipped(skipped)}` : ""}`);
  };

  return { addEquation, placeWithTool, addDrawing, addAiDrawing, addMermaid };
}
