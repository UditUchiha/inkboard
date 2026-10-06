import { Dialog } from "../../components/Dialog";
import { TOOLS } from "./constants";

const isMac = typeof navigator !== "undefined" && /Mac|iPhone|iPad/.test(navigator.platform);
const MOD = isMac ? "⌘" : "Ctrl";

const ACTIONS = [
  { label: "Undo", keys: [MOD, "Z"] },
  { label: "Redo", keys: [MOD, "Shift", "Z"] },
  { label: "Duplicate selection", keys: [MOD, "D"] },
  { label: "Delete selection", keys: ["Delete"] },
  { label: "Nudge selection", keys: ["Arrow keys"] },
  { label: "Pan while held", keys: ["Space"] },
  { label: "Zoom in / out", keys: [MOD, "+ / −"] },
  { label: "Reset zoom", keys: [MOD, "0"] },
  { label: "Fit drawing to screen", keys: ["Shift", "1"] },
  { label: "Resize or turn selection", keys: ["Drag a handle"] },
  { label: "Keep proportions, snap turns to 15°", keys: ["Shift + drag"] },
  { label: "Constrain a new shape or line", keys: ["Shift + drag"] },
  { label: "Finish text", keys: ["Esc"] },
];

function Keys({ keys }) {
  return (
    <span className="flex shrink-0 gap-1">
      {keys.map((key) => (
        <kbd key={key} className="rounded-md border border-rule bg-surface-2 px-1.5 py-0.5 font-sans text-xs text-ink">
          {key}
        </kbd>
      ))}
    </span>
  );
}

export function ShortcutsDialog({ open, onClose }) {
  return (
    <Dialog open={open} onClose={onClose} title="Keyboard shortcuts" className="w-[min(40rem,calc(100vw-2rem))]">
      <div className="grid gap-x-8 gap-y-6 sm:grid-cols-2">
        <section>
          <h3 className="mb-2 text-sm font-medium text-graphite">Tools</h3>
          <ul className="grid gap-2">
            {TOOLS.map((tool, index) => (
              <li key={tool.id} className="flex items-center justify-between gap-4 text-sm">
                {tool.label}
                <Keys keys={[tool.key.toUpperCase(), String(index + 1)]} />
              </li>
            ))}
          </ul>
        </section>
        <section>
          <h3 className="mb-2 text-sm font-medium text-graphite">Editing and view</h3>
          <ul className="grid gap-2">
            {ACTIONS.map((action) => (
              <li key={action.label} className="flex items-center justify-between gap-4 text-sm">
                {action.label}
                <Keys keys={action.keys} />
              </li>
            ))}
          </ul>
        </section>
      </div>
    </Dialog>
  );
}
