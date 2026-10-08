import clsx from "clsx";
import {
  ArrowUpRight,
  Circle,
  Eraser,
  Frame,
  Hand,
  ImagePlus,
  Minus,
  MousePointer2,
  MessageSquarePlus,
  Pencil,
  Square,
  StickyNote,
  Type,
} from "lucide-react";
import { Fragment } from "react";
import { COMMENT_TOOL, NUMBERED_TOOLS, TOOLS } from "./constants";

const ICONS = {
  comment: MessageSquarePlus,
  select: MousePointer2,
  hand: Hand,
  pen: Pencil,
  rectangle: Square,
  ellipse: Circle,
  arrow: ArrowUpRight,
  line: Minus,
  text: Type,
  sticky: StickyNote,
  frame: Frame,
  eraser: Eraser,
};

// Dividers separate navigation, drawing, notes and frames, and erasing.
const GROUP_STARTS = new Set(["pen", "sticky", "eraser", "comment"]);

export function Toolbar({ tool, onToolChange, onAddImage, withComments = false, className }) {
  const tools = withComments ? [...TOOLS, COMMENT_TOOL] : TOOLS;
  return (
    <div
      role="toolbar"
      aria-label="Tools"
      className={clsx("floating-panel flex items-center gap-0.5 rounded-xl p-1", className)}
    >
      {tools.map((item, index) => {
        const Icon = ICONS[item.id];
        const active = tool === item.id;
        const numbered = index < NUMBERED_TOOLS;
        return (
          <Fragment key={item.id}>
            {GROUP_STARTS.has(item.id) && <span className="mx-1 h-6 w-px bg-rule" aria-hidden />}
            <button
              type="button"
              aria-label={`${item.label} (${item.key.toUpperCase()}${numbered ? ` or ${index + 1}` : ""})`}
              aria-pressed={active}
              onClick={() => onToolChange(item.id)}
              className={clsx(
                "group relative grid size-10 place-items-center rounded-lg transition-colors",
                active ? "bg-marker text-[#16213a]" : "text-ink hover:bg-ink/6",
              )}
            >
              <Icon className="size-[18px]" strokeWidth={1.75} aria-hidden />
              {numbered && (
                <span
                  className={clsx(
                    "absolute right-1 bottom-0.5 text-[9px] leading-none tabular-nums",
                    active ? "text-[#16213a]/60" : "text-graphite/70",
                  )}
                  aria-hidden
                >
                  {index + 1}
                </span>
              )}
              <span
                className="pointer-events-none absolute top-full left-1/2 z-20 mt-2 -translate-x-1/2 rounded-md bg-ink px-2 py-1 text-xs whitespace-nowrap text-on-ink opacity-0 transition-opacity delay-300 group-hover:opacity-100 max-md:hidden"
                aria-hidden
              >
                {item.label} <kbd className="ml-1 font-sans text-on-ink/60">{item.key.toUpperCase()}</kbd>
              </span>
            </button>
            {/* Adding a picture is an action, not a tool: it opens the file picker. */}
            {item.id === "text" && onAddImage && (
              <button
                type="button"
                aria-label="Add image (I)"
                onClick={onAddImage}
                className="group relative grid size-10 place-items-center rounded-lg text-ink transition-colors hover:bg-ink/6"
              >
                <ImagePlus className="size-[18px]" strokeWidth={1.75} aria-hidden />
                <span
                  className="pointer-events-none absolute top-full left-1/2 z-20 mt-2 -translate-x-1/2 rounded-md bg-ink px-2 py-1 text-xs whitespace-nowrap text-on-ink opacity-0 transition-opacity delay-300 group-hover:opacity-100 max-md:hidden"
                  aria-hidden
                >
                  Add image <kbd className="ml-1 font-sans text-on-ink/60">I</kbd>
                </span>
              </button>
            )}
          </Fragment>
        );
      })}
    </div>
  );
}
