import type { Element as BoardElement } from "@inkboard/shared/types";
import { describeElement } from "../lib/elements/elementLabels";

export interface SelectionAnnouncerProps {
  selected: BoardElement | null;
  connectTo: BoardElement | null;
  connectIndex: number;
  connectCount: number;
  getElement: (id: string) => BoardElement | undefined;
}

// Announces what's selected, or the shape on offer while connecting; shown to all under the toolbar.
export function SelectionAnnouncer({
  selected,
  connectTo,
  connectIndex,
  connectCount,
  getElement,
}: SelectionAnnouncerProps) {
  return (
    <div
      role="status"
      className={
        connectTo
          ? "floating-panel absolute top-20 left-1/2 z-20 w-max max-w-[calc(100vw-1.5rem)] -translate-x-1/2 rounded-xl px-3 py-2 text-sm"
          : "sr-only"
      }
    >
      {connectTo
        ? `Arrow to ${describeElement(connectTo)} (${connectIndex + 1} of ${connectCount}). Tab for the next, Enter to draw it, Esc to stop.`
        : selected
          ? `Selected: ${describeElement(selected, getElement)}`
          : ""}
    </div>
  );
}
