import { Dialog } from "../../components/Dialog";
import { COMMENT_TOOL, NUMBERED_TOOLS, TOOLS } from "./constants";

// `navigator.platform` is deprecated; the user agent data (or, failing that, the user agent) says it as well.
const platform = typeof navigator === "undefined" ? "" : (navigator.userAgentData?.platform ?? navigator.userAgent);
const isMac = /Mac|iPhone|iPad/.test(platform);
const MOD = isMac ? "⌘" : "Ctrl";

// What anyone can do, including people who can only view the board.
const VIEW_ACTIONS = [
  { label: "Pan while held", keys: ["Space"] },
  { label: "Zoom in / out", keys: [MOD, "+ / −"] },
  { label: "Reset zoom", keys: [MOD, "0"] },
  { label: "Fit drawing to screen", keys: ["Shift", "1"] },
  { label: "Deselect, close a comment, stop following", keys: ["Esc"] },
  { label: "Show these shortcuts", keys: ["?"] },
];

// What needs the right to edit.
const EDIT_ACTIONS = [
  { label: "Undo", keys: [MOD, "Z"] },
  { label: "Redo", keys: [MOD, "Shift", "Z"] },
  { label: "Redo (alternative)", keys: [MOD, "Y"] },
  { label: "Duplicate selection", keys: [MOD, "D"] },
  { label: "Delete selection", keys: ["Delete / Backspace"] },
  { label: "Nudge selection", keys: ["Arrow keys"] },
  { label: "Edit selected text, note or label", keys: ["Enter"] },
  { label: "Bring forward / send backward", keys: [MOD, "] / ["] },
  { label: "Bring to front / send to back", keys: [MOD, "Shift", "] / ["] },
  { label: "Add an image", keys: ["I"] },
  { label: "Paste or drop an image", keys: [MOD, "V"] },
  { label: "Resize or turn selection", keys: ["Drag a handle"] },
  { label: "Keep proportions, snap turns to 15°", keys: ["Shift + drag"] },
  { label: "Constrain a new shape or line", keys: ["Shift + drag"] },
  { label: "Finish text or a note", keys: ["Esc"] },
  { label: "Finish text or a note (alternative)", keys: [MOD, "Enter"] },
  { label: "Finish a label", keys: ["Enter"] },
  { label: "New line in a label", keys: ["Shift", "Enter"] },
  { label: "Move a frame and everything in it", keys: ["Drag the frame"] },
];

function Keys({ keys }) {
  return (
    <span className="flex shrink-0 gap-1">
      {keys.map((key, index) => (
        <kbd
          key={index}
          className="rounded-md border border-rule bg-surface-2 px-1.5 py-0.5 font-sans text-xs text-ink"
        >
          {key}
        </kbd>
      ))}
    </span>
  );
}

/** `readOnly`: the person can only look, so only what looking needs is listed. `canComment` adds the comment tool. */
export function ShortcutsDialog({ open, onClose, readOnly = false, canComment = false }) {
  const tools = canComment ? [...TOOLS, COMMENT_TOOL] : TOOLS;
  const actions = readOnly ? VIEW_ACTIONS : [...EDIT_ACTIONS, ...VIEW_ACTIONS];
  return (
    <Dialog open={open} onClose={onClose} title="Keyboard shortcuts" className="w-[min(40rem,calc(100vw-2rem))]">
      <div className="grid gap-x-8 gap-y-6 sm:grid-cols-2">
        {!readOnly && (
          <section>
            <h3 className="mb-2 text-sm font-medium text-graphite">Tools</h3>
            <ul className="grid gap-2">
              {tools.map((tool, index) => (
                <li key={tool.id} className="flex items-center justify-between gap-4 text-sm">
                  {tool.label}
                  <Keys
                    keys={
                      index < NUMBERED_TOOLS ? [tool.key.toUpperCase(), String(index + 1)] : [tool.key.toUpperCase()]
                    }
                  />
                </li>
              ))}
            </ul>
          </section>
        )}
        <section>
          <h3 className="mb-2 text-sm font-medium text-graphite">{readOnly ? "Looking around" : "Editing and view"}</h3>
          <ul className="grid gap-2">
            {actions.map((action) => (
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
