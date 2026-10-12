import { Check, Link2, LoaderCircle, Pause, Play, X } from "lucide-react";
import type { ReplayReply } from "@inkboard/shared/socket";
import { useEffect, useMemo, useRef, useState } from "react";
import { toast } from "sonner";
import { Button, IconButton } from "../../components/Button";
import { BoardPreview } from "./BoardPreview";
import { isPressable, isTypingTarget } from "./domTargets";
import { createReplay } from "./replay";
import type { Replay } from "./replay";

// How long each step shows at 1×. Steps are a few seconds of work each, so even 1× is a timelapse.
const STEP_MS = 300;
const SPEEDS = [1, 2, 4];

const formatWhen = (at: number) => new Date(at).toLocaleString(undefined, { dateStyle: "medium", timeStyle: "short" });

/** What the replay player takes: the board's title, how to load its replay, and what closing does. */
export type ReplayPlayerProps = {
  title: string;
  load: () => Promise<ReplayReply>;
  onClose: () => void;
};

/**
 * A board's replay, over the whole screen: plays how the board was built, step by step (see replay.ts), with a
 * slider to scrub through it. Space plays and pauses, the arrow keys step, Home and End jump, and Escape closes.
 */
export function ReplayPlayer({ title, load, onClose }: ReplayPlayerProps) {
  const [replay, setReplay] = useState<Replay | null>(null);
  const [error, setError] = useState("");
  const [index, setIndex] = useState(0);
  const [playing, setPlaying] = useState(false);
  const [speed, setSpeed] = useState(SPEEDS[0]);
  const [copied, setCopied] = useState(false);
  // Focus comes in from the menu that opened this, so Space plays rather than pressing the menu's button again.
  const dialog = useRef<HTMLDivElement>(null);
  useEffect(() => dialog.current?.focus(), []);

  useEffect(() => {
    let active = true;
    load().then((reply) => {
      if (!active) return;
      if (!reply.ok) return setError(reply.error);
      setReplay(createReplay(reply.steps, reply.elements));
      setPlaying(reply.steps.length > 0);
    });
    return () => {
      active = false;
    };
  }, [load]);

  const last = (replay?.length ?? 1) - 1;
  const frame = useMemo(() => replay?.frameAt(index) ?? [], [replay, index]);
  const time = replay?.timeAt(index);

  // Playing moves on a step at a time, and stops on the last one (the board as it is now).
  useEffect(() => {
    if (!playing) return undefined;
    if (index >= last) {
      setPlaying(false);
      return undefined;
    }
    const timer = setTimeout(() => setIndex((at) => at + 1), STEP_MS / speed);
    return () => clearTimeout(timer);
  }, [playing, index, last, speed]);

  const go = (to: number) => {
    setPlaying(false);
    setIndex(Math.max(0, Math.min(last, to)));
  };
  const togglePlaying = () => {
    if (!playing && index >= last) setIndex(0); // from the start again
    setPlaying(!playing);
  };

  useEffect(() => {
    const onKeyDown = (event: KeyboardEvent) => {
      if (event.ctrlKey || event.metaKey || event.altKey || isTypingTarget(event.target)) return;
      const onSlider = event.target instanceof HTMLInputElement; // which steps with the arrow keys itself
      if (event.key === "Escape") onClose();
      else if (!replay) return;
      else if (event.key === " " && !isPressable(event.target)) togglePlaying();
      else if (event.key === "ArrowRight" && !onSlider) go(index + 1);
      else if (event.key === "ArrowLeft" && !onSlider) go(index - 1);
      else if (event.key === "Home") go(0);
      else if (event.key === "End") go(last);
      else return;
      event.preventDefault();
    };
    window.addEventListener("keydown", onKeyDown);
    return () => window.removeEventListener("keydown", onKeyDown);
  });

  // The board's own link with ?replay, which opens this for whoever may watch it.
  async function copyLink() {
    try {
      const link = new URL(window.location.href);
      link.searchParams.delete("thread");
      link.searchParams.set("replay", "");
      await navigator.clipboard.writeText(link.href);
      setCopied(true);
      setTimeout(() => setCopied(false), 2000);
    } catch {
      toast.error("Couldn't copy the link. Copy it from the address bar instead.");
    }
  }

  return (
    <div
      ref={dialog}
      tabIndex={-1}
      role="dialog"
      aria-modal="true"
      aria-label="Replay"
      className="fixed inset-0 z-40 flex flex-col bg-surface outline-none"
    >
      <div className="flex items-center gap-2 border-b border-rule px-3 py-2">
        <h2 className="min-w-0 flex-1 truncate font-medium">
          Replay <span className="text-graphite">· {title}</span>
        </h2>
        <Button variant="secondary" size="sm" icon={copied ? Check : Link2} onClick={copyLink}>
          {copied ? "Copied" : "Copy link"}
        </Button>
        <IconButton label="Close replay" icon={X} onClick={onClose} />
      </div>

      <div className="relative min-h-0 flex-1">
        {replay && (
          <BoardPreview
            elements={frame}
            bounds={replay.bounds}
            padding={48}
            maxZoom={2}
            smallImages={false}
            className="h-full w-full"
          />
        )}
        <div className="absolute inset-0 grid place-items-center p-6 text-center" aria-live="polite">
          {error ? (
            <p className="text-danger">{error}</p>
          ) : !replay ? (
            <LoaderCircle className="size-6 animate-spin text-graphite" aria-label="Loading the replay" />
          ) : (
            last === 0 && (
              <p className="floating-panel rounded-xl px-4 py-3 text-sm">
                Nothing is recorded yet. The replay records the changes made to this board from now on.
              </p>
            )
          )}
        </div>
      </div>

      {replay && last > 0 && (
        <div className="flex items-center gap-3 border-t border-rule px-3 py-2">
          <IconButton label={playing ? "Pause" : "Play"} icon={playing ? Pause : Play} onClick={togglePlaying} />
          <input
            type="range"
            min={0}
            max={last}
            value={index}
            onChange={(event) => go(Number(event.target.value))}
            aria-label="Position in the replay"
            aria-valuetext={time ? formatWhen(time) : "Now"}
            className="min-w-0 flex-1 accent-signal"
          />
          <span className="w-40 shrink-0 text-right text-sm text-graphite tabular-nums max-sm:hidden">
            {time ? formatWhen(time) : "Now"}
          </span>
          <button
            type="button"
            onClick={() => setSpeed(SPEEDS[(SPEEDS.indexOf(speed) + 1) % SPEEDS.length])}
            title="Playback speed"
            className="h-10 min-w-12 rounded-lg px-2 text-sm font-medium tabular-nums transition-colors hover:bg-ink/6"
          >
            {speed}×
          </button>
        </div>
      )}
    </div>
  );
}
