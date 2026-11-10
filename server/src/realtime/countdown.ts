import { MAX_COUNTDOWN_SECONDS } from "@inkboard/shared/limits";
import type { Countdown } from "@inkboard/shared/socket";

// The board's timer: editors start, pause, resume and stop it. It lives in the open session and is saved with the board,
// so it carries on counting when everyone has left.

export type CountdownState = { total: number; left: number; since: number | null };

export function countdownAt(state: CountdownState | null, now: number): Countdown | null {
  if (!state) return null;
  const left = state.since === null ? state.left : Math.max(0, state.left - (now - state.since));
  return { total: state.total, left, running: state.since !== null && left > 0 };
}

// undefined when the event isn't one (a browser can send anything) or changes nothing, such as pausing a paused timer
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

export function readCountdown(saved: unknown): CountdownState | null {
  if (!saved || typeof saved !== "object") return null;
  const { total, left, since } = saved as { total?: unknown; left?: unknown; since?: unknown };
  return isTime(total) && isTime(left) && (since === null || isTime(since)) ? { total, left, since } : null;
}
