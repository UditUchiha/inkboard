import { MAX_COUNTDOWN_SECONDS } from "@inkboard/shared/limits";
import type { Countdown } from "@inkboard/shared/socket";

// A board's timer, which everyone on the board sees and anyone who can edit it starts, pauses, resumes and stops.
// It's kept with the board's open session and saved with the board, so it carries on counting when everyone has left.

/** The timer as the session keeps it: how long it was set for, how long was left at `since`, and when it last started counting (null while paused), all in milliseconds. */
export type CountdownState = { total: number; left: number; since: number | null };

/** The timer as browsers are told of it at `now` (see Countdown), or null if there's none. */
export function countdownAt(state: CountdownState | null, now: number): Countdown | null {
  if (!state) return null;
  const left = state.since === null ? state.left : Math.max(0, state.left - (now - state.since));
  return { total: state.total, left, running: state.since !== null && left > 0 };
}

/**
 * The timer after a `countdown` event at `now`: a new state, null when it was stopped, or undefined when the
 * event isn't one (a browser can send anything) or changes nothing, such as pausing a paused timer.
 */
export function nextCountdown(
  state: CountdownState | null,
  payload: unknown,
  now: number,
): CountdownState | null | undefined {
  if (!payload || typeof payload !== "object") return undefined;
  const { action, seconds } = payload as { action?: unknown; seconds?: unknown };
  const current = countdownAt(state, now);
  switch (action) {
    case "start": {
      if (typeof seconds !== "number" || !(seconds >= 1 && seconds <= MAX_COUNTDOWN_SECONDS)) return undefined;
      const total = Math.round(seconds) * 1000;
      return { total, left: total, since: now };
    }
    case "pause":
      return state && current?.running ? { total: state.total, left: current.left, since: null } : undefined;
    case "resume":
      return state && state.since === null && state.left > 0 ? { ...state, since: now } : undefined;
    case "stop":
      return state ? null : undefined;
    default:
      return undefined;
  }
}

const isTime = (value: unknown): value is number => typeof value === "number" && Number.isFinite(value) && value >= 0;

/** A timer as it was saved with the board, or null if what's there isn't one. It saves as it's kept. */
export function readCountdown(saved: unknown): CountdownState | null {
  if (!saved || typeof saved !== "object") return null;
  const { total, left, since } = saved as { total?: unknown; left?: unknown; since?: unknown };
  return isTime(total) && isTime(left) && (since === null || isTime(since)) ? { total, left, since } : null;
}
