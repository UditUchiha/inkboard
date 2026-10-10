import clsx from "clsx";
import { ListTree } from "lucide-react";
import { useState } from "react";
import { describeElement } from "./elementLabels";

// Showing this many keeps the page light on a big board; the rest are reachable by selecting on the canvas.
const MAX_LISTED = 200;

/**
 * The canvas can't be tabbed through, so this lists its elements as buttons: Tab to move between them,
 * Enter to select one (then arrow keys move it, Delete removes it). Hidden until it gets keyboard focus.
 */
export function ElementList({ elements, selectedId, onSelect }) {
  const [open, setOpen] = useState(false);
  const listed = elements.slice(0, MAX_LISTED);

  return (
    <div className="sr-only focus-within:not-sr-only focus-within:absolute focus-within:bottom-[7.5rem] focus-within:left-1/2 focus-within:z-20 focus-within:-translate-x-1/2 md:focus-within:bottom-16">
      <div className="floating-panel w-[min(22rem,calc(100vw-1.5rem))] rounded-xl p-1">
        <button
          type="button"
          aria-expanded={open}
          onClick={() => setOpen((value) => !value)}
          className="flex h-10 w-full items-center gap-2 rounded-lg px-3 text-left text-sm font-medium hover:bg-ink/6"
        >
          <ListTree className="size-4" aria-hidden />
          {elements.length === 1 ? "1 element on the board" : `${elements.length} elements on the board`}
        </button>
        {open && (
          <ul aria-label="Board elements" className="max-h-64 overflow-y-auto">
            {listed.map((element) => (
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
                  {describeElement(element)}
                </button>
              </li>
            ))}
            {elements.length > listed.length && (
              <li className="px-3 py-1.5 text-sm text-graphite">and {elements.length - listed.length} more</li>
            )}
          </ul>
        )}
      </div>
    </div>
  );
}
