import clsx from "clsx";
import { LayoutGrid, List } from "lucide-react";
import type { View } from "../lib/sections";

interface ViewToggleProps {
  view: View;
  onChange: (view: View) => void;
}

export function ViewToggle({ view, onChange }: ViewToggleProps) {
  return (
    <div role="group" aria-label="Layout" className="flex gap-1 rounded-lg bg-ink/5 p-1">
      {(
        [
          ["grid", "Grid view", LayoutGrid],
          ["list", "List view", List],
        ] as const
      ).map(([id, label, Icon]) => (
        <button
          key={id}
          type="button"
          aria-pressed={view === id}
          aria-label={label}
          title={label}
          onClick={() => onChange(id)}
          className={clsx(
            "grid size-8 place-items-center rounded-md transition-colors",
            view === id ? "bg-surface text-ink shadow-sm" : "text-graphite hover:text-ink",
          )}
        >
          <Icon className="size-4" aria-hidden />
        </button>
      ))}
    </div>
  );
}
