import { ChevronLeft, ChevronRight, X } from "lucide-react";
import type { FrameElement } from "@inkboard/shared/types";
import { useEffect } from "react";
import { IconButton } from "../../components/Button";
import { isPressable, isTypingTarget } from "./domTargets";

/** What the presenter's bar takes: the frames in the order they're shown, which one is on show, and what to do. */
export type PresenterProps = {
  slides: FrameElement[];
  index: number;
  onIndex: (index: number) => void;
  onExit: () => void;
};

/**
 * The bar at the bottom while presenting: back, where we are, forward and stop. The arrow keys, Page Up and Down,
 * Space, Home and End move between frames, and Escape (or leaving full screen) stops.
 */
export function Presenter({ slides, index, onIndex, onExit }: PresenterProps) {
  const last = slides.length - 1;
  const go = (to: number) => onIndex(Math.max(0, Math.min(last, to)));

  // Full screen while presenting; the browser's own way out of it (Escape, mostly) ends the presentation too.
  useEffect(() => {
    let entered = false;
    const onChange = () => {
      if (document.fullscreenElement) entered = true;
      else if (entered) onExit();
    };
    document.addEventListener("fullscreenchange", onChange);
    document.documentElement.requestFullscreen?.().catch(() => {}); // refused (an iframe, an old phone): shown as is
    return () => {
      document.removeEventListener("fullscreenchange", onChange);
      if (document.fullscreenElement) document.exitFullscreen().catch(() => {});
    };
  }, [onExit]);

  useEffect(() => {
    const onKeyDown = (event: KeyboardEvent) => {
      if (event.defaultPrevented || event.ctrlKey || event.metaKey || event.altKey || isTypingTarget(event.target))
        return;
      // Space on a focused button presses it, which is a move already.
      const step = (
        {
          ArrowRight: 1,
          ArrowDown: 1,
          PageDown: 1,
          " ": isPressable(event.target) ? 0 : 1,
          ArrowLeft: -1,
          ArrowUp: -1,
          PageUp: -1,
        } as Record<string, number>
      )[event.key];
      if (step) go(index + step);
      else if (event.key === "Home") go(0);
      else if (event.key === "End") go(last);
      else if (event.key === "Escape") onExit();
      else return;
      event.preventDefault(); // the board's own shortcuts (nudging, panning with Space) skip it
    };
    // Captured, so it comes before the board's shortcuts, which listen on the window too.
    window.addEventListener("keydown", onKeyDown, true);
    return () => window.removeEventListener("keydown", onKeyDown, true);
  });

  return (
    <div className="absolute bottom-4 left-1/2 -translate-x-1/2 opacity-40 transition-opacity focus-within:opacity-100 hover:opacity-100">
      <div className="floating-panel flex items-center gap-1 rounded-xl p-1">
        <IconButton label="Previous frame" icon={ChevronLeft} onClick={() => go(index - 1)} disabled={index === 0} />
        <span className="max-w-64 truncate px-2 text-sm tabular-nums" aria-live="polite">
          {index + 1} / {slides.length}
          <span className="text-graphite"> · {slides[index].name}</span>
        </span>
        <IconButton label="Next frame" icon={ChevronRight} onClick={() => go(index + 1)} disabled={index === last} />
        <IconButton label="Stop presenting" icon={X} onClick={onExit} />
      </div>
    </div>
  );
}
