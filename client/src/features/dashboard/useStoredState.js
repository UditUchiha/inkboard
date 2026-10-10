import { useCallback, useState } from "react";

// Storage is looked up inside the try, never as a default parameter: with site data blocked, merely
// reading `localStorage` throws a SecurityError, which would otherwise escape and crash the page.

/**
 * What is saved under `key`, or `initial` when nothing usable is: no storage, a broken value, or
 * one `isValid` refuses (an old format, say), so a stale entry can never crash the page.
 */
export function readStored(key, initial, isValid = () => true, storage) {
  try {
    const saved = (storage ?? globalThis.localStorage).getItem(key);
    if (saved === null) return initial;
    const value = JSON.parse(saved);
    return isValid(value) ? value : initial;
  } catch {
    return initial;
  }
}

/** Saves `value` under `key` if this browser lets us; without storage the choice lasts until reload. */
export function writeStored(key, value, storage) {
  try {
    (storage ?? globalThis.localStorage).setItem(key, JSON.stringify(value));
  } catch {
    // Storage unavailable or full.
  }
}

/** Like useState, but remembered in this browser (and fine without storage). */
export function useStoredState(key, initial, isValid) {
  const [value, setValue] = useState(() => readStored(key, initial, isValid));

  const update = useCallback(
    (next) => {
      setValue(next);
      writeStored(key, next);
    },
    [key],
  );
  return [value, update];
}
