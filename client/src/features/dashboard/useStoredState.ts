import { useCallback, useState } from "react";

// Storage is looked up inside the try, never as a default parameter: with site data blocked, merely
// reading `localStorage` throws a SecurityError, which would otherwise escape and crash the page.

/**
 * What is saved under `key`, or `initial` when nothing usable is: no storage, a broken value, or
 * one `isValid` refuses (an old format, say), so a stale entry can never crash the page.
 */
export function readStored<T>(
  key: string,
  initial: T,
  isValid: (value: unknown) => boolean = () => true,
  storage?: Pick<Storage, "getItem">,
) {
  try {
    const saved = (storage ?? globalThis.localStorage).getItem(key);
    if (saved === null) return initial;
    const value: unknown = JSON.parse(saved);
    // `isValid` vouches that a stored value is a T.
    return isValid(value) ? (value as T) : initial;
  } catch {
    return initial;
  }
}

/** Saves `value` under `key` if this browser lets us; without storage the choice lasts until reload. */
export function writeStored(key: string, value: unknown, storage?: Pick<Storage, "setItem">) {
  try {
    (storage ?? globalThis.localStorage).setItem(key, JSON.stringify(value));
  } catch {
    // Storage unavailable or full.
  }
}

/** Like useState, but remembered in this browser (and fine without storage). */
export function useStoredState<T>(
  key: string,
  initial: T,
  isValid?: (value: unknown) => boolean,
): [T, (next: T) => void] {
  const [value, setValue] = useState(() => readStored(key, initial, isValid));

  const update = useCallback(
    (next: T) => {
      setValue(next);
      writeStored(key, next);
    },
    [key],
  );
  return [value, update];
}
