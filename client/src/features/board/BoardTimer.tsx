import { MAX_COUNTDOWN_SECONDS } from "@inkboard/shared/limits";
import type { CountdownPayload } from "@inkboard/shared/socket";
import clsx from "clsx";
import { Pause, Play, Timer, X } from "lucide-react";
import { useEffect, useRef, useState } from "react";
import type { FormEvent } from "react";
import { IconButton } from "../../components/Button";
import { Menu, MenuItem, MenuLabel, MenuSeparator, useCloseMenu } from "../../components/Menu";
import type { BoardTimer as Timed } from "./useBoardSync";

const PRESET_MINUTES = [1, 3, 5, 10, 15];

/** How long the timer has left at `now`, in milliseconds (a `now` from before it was heard of counts as then). */
export const timeLeft = (timer: Timed, now: number): number =>
  timer.running ? Math.max(0, timer.left - Math.max(0, now - timer.at)) : timer.left;

/** Milliseconds as the timer shows them: 4:05, or 1:02:03 past an hour. Partial seconds count up, so 0:00 means done. */
export function formatTimeLeft(ms: number): string {
  const total = Math.ceil(ms / 1000);
  const hours = Math.floor(total / 3600);
  const minutes = Math.floor((total % 3600) / 60);
  const seconds = String(total % 60).padStart(2, "0");
  return hours > 0 ? `${hours}:${String(minutes).padStart(2, "0")}:${seconds}` : `${minutes}:${seconds}`;
}

// Three rising notes, made on the spot: a browser that hasn't been clicked yet may keep it quiet, which is fine.
function chime() {
  try {
    const audio = new AudioContext();
    [660, 880, 1320].forEach((frequency, index) => {
      const start = audio.currentTime + index * 0.18;
      const tone = audio.createOscillator();
      const volume = audio.createGain();
      tone.frequency.value = frequency;
      volume.gain.setValueAtTime(0.0001, start);
      volume.gain.exponentialRampToValueAtTime(0.2, start + 0.02);
      volume.gain.exponentialRampToValueAtTime(0.0001, start + 0.5);
      tone.connect(volume).connect(audio.destination);
      tone.start(start);
      tone.stop(start + 0.55);
    });
    setTimeout(() => void audio.close(), 1500);
  } catch {
    // No sound, then; the timer still shows that time is up.
  }
}

// A number of minutes to start the timer for, typed in the menu.
function CustomMinutes({ onStart }: { onStart: (seconds: number) => void }) {
  const close = useCloseMenu();
  const [minutes, setMinutes] = useState("");
  const submit = (event: FormEvent<HTMLFormElement>) => {
    event.preventDefault();
    const seconds = Math.round(Number(minutes) * 60);
    if (!(seconds >= 1 && seconds <= MAX_COUNTDOWN_SECONDS)) return;
    close();
    onStart(seconds);
  };
  return (
    <form onSubmit={submit} className="flex items-center gap-2 px-2.5 py-1.5">
      <label className="flex flex-1 items-center gap-2 text-sm text-ink">
        <input
          type="number"
          min={0.1}
          max={MAX_COUNTDOWN_SECONDS / 60}
          step="any"
          value={minutes}
          onChange={(event) => setMinutes(event.target.value)}
          onKeyDown={(event) => event.stopPropagation()}
          className="w-16 rounded-md border border-rule bg-surface px-2 py-1 text-sm tabular-nums focus:border-signal focus:outline-none"
        />
        minutes
      </label>
      <button
        type="submit"
        disabled={!(Number(minutes) > 0)}
        className="rounded-md bg-ink px-2.5 py-1 text-sm text-on-ink disabled:opacity-40"
      >
        Start
      </button>
    </form>
  );
}

/** The button that starts the board's timer for everyone (see BoardTimer), for those who can edit the board. */
export function StartTimer({ onStart }: { onStart: (seconds: number) => void }) {
  return (
    <Menu side="top" trigger={(props) => <IconButton label="Timer" icon={Timer} {...props} />}>
      <MenuLabel>Start a timer for everyone</MenuLabel>
      {PRESET_MINUTES.map((minutes) => (
        <MenuItem key={minutes} onSelect={() => onStart(minutes * 60)}>
          {minutes} {minutes === 1 ? "minute" : "minutes"}
        </MenuItem>
      ))}
      <MenuSeparator />
      <CustomMinutes onStart={onStart} />
    </Menu>
  );
}

/** What the board's timer takes: the timer, whether this person may set it, and how to. */
export type BoardTimerProps = {
  timer: Timed | null;
  canControl: boolean;
  onControl: (payload: CountdownPayload) => void;
};

/**
 * The board's timer, which everyone on it sees count down under the toolbar, once someone who can edit the board
 * has started it (see StartTimer). They pause, resume or stop it here. When time is up it says so, with a chime.
 */
export function BoardTimer({ timer, canControl, onControl }: BoardTimerProps) {
  const [now, setNow] = useState(Date.now);
  const left = timer ? timeLeft(timer, now) : 0;
  const ticking = Boolean(timer?.running) && left > 0;
  const done = Boolean(timer) && left === 0;

  useEffect(() => {
    if (!ticking) return undefined;
    const interval = setInterval(() => setNow(Date.now()), 250);
    return () => clearInterval(interval);
  }, [ticking]);

  // The chime is for a timer seen running out here, not for one that had run out before this person came.
  const sawRunning = useRef(false);
  useEffect(() => {
    if (ticking) sawRunning.current = true;
    else if (done && sawRunning.current) {
      sawRunning.current = false;
      chime();
    } else if (!timer) sawRunning.current = false;
  }, [ticking, done, timer]);

  if (!timer) return null;

  return (
    <div
      className={clsx(
        "floating-panel flex h-10 items-center gap-1 rounded-xl pr-1 pl-3",
        done && "bg-marker! text-[#16213a]",
      )}
    >
      <Timer className="size-4 shrink-0" strokeWidth={1.75} aria-hidden />
      <span role="timer" aria-label="Time left" className="min-w-11 text-sm font-semibold tabular-nums">
        {formatTimeLeft(left)}
      </span>
      {/* Said once when time is up, for screen readers (the count itself isn't read out every second). */}
      <span aria-live="polite" className={clsx("text-sm font-medium", !done && "sr-only")}>
        {done ? "Time's up" : ""}
      </span>
      {canControl && !done && (
        <IconButton
          size="sm"
          label={timer.running ? "Pause timer" : "Resume timer"}
          icon={timer.running ? Pause : Play}
          onClick={() => onControl({ action: timer.running ? "pause" : "resume" })}
        />
      )}
      {canControl && (
        <IconButton
          size="sm"
          label={done ? "Dismiss timer" : "Stop timer"}
          icon={X}
          onClick={() => onControl({ action: "stop" })}
          className={clsx(done && "text-[#16213a] hover:bg-[#16213a]/10")}
        />
      )}
      {!canControl && <span className="w-2" />}
    </div>
  );
}
