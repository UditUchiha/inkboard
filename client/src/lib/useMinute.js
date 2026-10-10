import { useSyncExternalStore } from "react";

const listeners = new Set();
let timer = null;
let minute = Math.floor(Date.now() / 60_000);

function subscribe(listener) {
  listeners.add(listener);
  // One shared clock for every "5 minutes ago" on the page, running only while something shows one.
  timer ??= setInterval(() => {
    minute = Math.floor(Date.now() / 60_000);
    for (const notify of listeners) notify();
  }, 60_000);
  return () => {
    listeners.delete(listener);
    if (listeners.size === 0) {
      clearInterval(timer);
      timer = null;
    }
  };
}

/** Re-renders the component once a minute, so times shown with `timeAgo` don't go stale. */
export const useMinute = () => useSyncExternalStore(subscribe, () => minute);
