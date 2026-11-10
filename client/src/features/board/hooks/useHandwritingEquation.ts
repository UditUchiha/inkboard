import type { Element as BoardElement, PenElement } from "@inkboard/shared/types";
import { useState } from "react";
import { toast } from "sonner";
import type { Style } from "../constants/board";
import { hasAiKey } from "../lib/ai/providers";
import { equationElement, strokesToRead } from "../lib/ai/handwriting";
import { canChange } from "../lib/elements/classroom";
import type { Zone } from "../lib/elements/classroom";
import { formulaOf } from "../lib/elements/math";
import type { BoardStore } from "../lib/sync/store";

interface HandwritingEquationOptions {
  store: BoardStore;
  selected: BoardElement | null;
  zone: Zone;
  student: boolean;
  style: Style;
  keepInZone: <T extends BoardElement>(element: T) => T | null;
  selectElement: (id: string) => void;
  toastWithUndo: (message: string) => void;
  openAiDialog: () => void;
}

export function useHandwritingEquation({
  store,
  selected,
  zone,
  student,
  style,
  keepInZone,
  selectElement,
  toastWithUndo,
  openAiDialog,
}: HandwritingEquationOptions) {
  // Handwriting to an equation (see handwriting.ts): Claude reads the selected stroke and those near it, or a frame's.
  const [readingStrokes, setReadingStrokes] = useState<PenElement[] | null>(null);
  function convertToEquation() {
    const strokes = selected
      ? strokesToRead(store.getElements(), selected).filter((each) => canChange(each, zone))
      : [];
    if (strokes.length === 0) {
      toast("There's no handwriting here to convert. Select something written with the pen.");
      return;
    }
    // It uses the key Draw with AI asks for, which students in classroom mode don't have the button for.
    if (!hasAiKey()) {
      toast("Converting handwriting uses your own AI key. Add one in Draw with AI first.", {
        action: student ? undefined : { label: "Draw with AI", onClick: openAiDialog },
      });
      return;
    }
    setReadingStrokes(strokes);
  }
  function insertEquation(latex: string) {
    // The assertion: the dialog that calls this is open only while there are strokes being read.
    const read = readingStrokes!;
    setReadingStrokes(null);
    const strokes = read.flatMap((stroke) => store.getElement(stroke.id) ?? []);
    const equation = keepInZone(equationElement(latex, read, formulaOf(`$$${latex}$$`), style));
    if (!equation) return;
    const removed = strokes.map((stroke) => stroke.id);
    store.commit({ undo: { upsert: strokes, remove: [equation.id] }, redo: { upsert: [equation], remove: removed } });
    selectElement(equation.id);
    toastWithUndo("Replaced the handwriting with an equation");
  }

  return { readingStrokes, setReadingStrokes, convertToEquation, insertEquation };
}
