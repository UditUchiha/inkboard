import { useCallback, useState } from "react";

// Storage is looked up inside the try, never as a default parameter: with site data blocked, merely
// reading `localStorage` throws a SecurityError, which would otherwise escape and crash the page.

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
    return isValid(value) ? (value as T) : initial;
  } catch {
    return initial;
  }
}

export function writeStored(key: string, value: unknown, storage?: Pick<Storage, "setItem">) {
  try {
    (storage ?? globalThis.localStorage).setItem(key, JSON.stringify(value));
  } catch {
    // Storage unavailable or full.
  }
}

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
