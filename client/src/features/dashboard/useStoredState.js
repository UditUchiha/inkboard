import { useCallback, useState } from "react";

/** Like useState, but remembered in this browser (and fine without storage). */
export function useStoredState(key, initial) {
  const [value, setValue] = useState(() => {
    try {
      const saved = localStorage.getItem(key);
      return saved === null ? initial : JSON.parse(saved);
    } catch {
      return initial;
    }
  });

  const update = useCallback(
    (next) => {
      setValue(next);
      try {
        localStorage.setItem(key, JSON.stringify(next));
      } catch {
        // Storage unavailable: the choice lasts until reload.
      }
    },
    [key],
  );
  return [value, update];
}
