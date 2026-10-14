import type { Element as BoardElement } from "@inkboard/shared/types";
import clsx from "clsx";
import { ListTree, X } from "lucide-react";
import { useDeferredValue, useMemo } from "react";
import { IconButton } from "../../components/Button";
import { describeElement } from "./elementLabels";
import { boardOutline } from "./elements";
import type { OutlineNode } from "./elements";

// Showing this many keeps the page light on a big board; the rest are reachable by selecting on the canvas.
const MAX_LISTED = 200;

/** What the outline takes: the board's elements, the one selected, what to do when one is picked, and whether it's open. */
export type ElementListProps = {
  elements: BoardElement[];
  selectedId: string | null;
  onSelect: (id: string) => void;
  open: boolean;
  onOpenChange: (open: boolean) => void;
};

/**
 * The board as an outline, for keyboards and screen readers: frames hold what's inside them, everything reads from the
 * top, left to right, and arrows say what they join. Tab moves between its buttons, Enter selects one (then arrow keys
 * move it, Delete removes it). While closed, only its button shows, and only once it has keyboard focus.
 */
export function ElementList({ elements, selectedId, onSelect, open, onOpenChange }: ElementListProps) {
  // Worked out when the board is quiet, not on every step of a drag, and only while open.
  const settled = useDeferredValue(elements);
  const { outline, find } = useMemo(() => {
    if (!open) return { outline: [], find: () => undefined };
    const byId = new Map(settled.map((element) => [element.id, element]));
    return { outline: boardOutline(settled, MAX_LISTED), find: (id: string) => byId.get(id) };
  }, [open, settled]);
  const count = elements.length === 1 ? "1 element on the board" : `${elements.length} elements on the board`;

  const list = (nodes: OutlineNode[], label?: string) => (
    <ul aria-label={label} className={clsx(!label && "ml-3 border-l border-rule pl-1")}>
      {nodes.map(({ element, children }) => (
        <li key={element.id}>
          <button
            type="button"
            aria-pressed={element.id === selectedId}
            onClick={() => onSelect(element.id)}
            className={clsx(
              "block w-full truncate rounded-lg px-3 py-1.5 text-left text-sm hover:bg-ink/6",
              element.id === selectedId && "bg-signal/10 font-medium",
            )}
          >
            {describeElement(element, find)}
          </button>
          {children.length > 0 && list(children)}
        </li>
      ))}
    </ul>
  );

  return (
    <div
      className={clsx(
        "z-20",
        open
          ? "absolute right-3 bottom-[7.5rem] md:bottom-16" // the left side has the style panel
          : "sr-only focus-within:not-sr-only focus-within:absolute focus-within:bottom-[7.5rem] focus-within:left-1/2 focus-within:-translate-x-1/2 md:focus-within:bottom-16",
      )}
    >
      <div className="floating-panel w-[min(22rem,calc(100vw-1.5rem))] rounded-xl p-1">
        <div className="flex items-center">
          <button
            type="button"
            aria-expanded={open}
            onClick={() => onOpenChange(!open)}
            className="flex h-10 flex-1 items-center gap-2 rounded-lg px-3 text-left text-sm font-medium hover:bg-ink/6"
          >
            <ListTree className="size-4" aria-hidden />
            {count}
          </button>
          {open && <IconButton label="Close the outline" icon={X} onClick={() => onOpenChange(false)} />}
        </div>
        {open && (
          <div className="max-h-[50vh] overflow-y-auto">
            {list(outline, "Board outline")}
            {elements.length > MAX_LISTED && (
              <p className="px-3 py-1.5 text-sm text-graphite">and {elements.length - MAX_LISTED} more</p>
            )}
          </div>
        )}
      </div>
    </div>
  );
}
