import { useSyncExternalStore } from "react";

// Where other people's pointers are: socket id -> { x, y } in board coordinates.
// They move about 20 times a second per person, so they live outside React
// state: only the component that draws them (RemoteCursors) subscribes, and the
// editor around it isn't rendered again for each one.

const NONE = {};

export function createCursorStore() {
  let cursors = NONE;
  const listeners = new Set();
  const set = (next) => {
    cursors = next;
    for (const listener of listeners) listener();
  };

  return {
    subscribe(listener) {
      listeners.add(listener);
      return () => listeners.delete(listener);
    },
    getSnapshot: () => cursors,
    /** Someone's pointer is at `point`; without one, it left the board. */
    move(socketId, point) {
      if (point) {
        set({ ...cursors, [socketId]: point });
      } else if (socketId in cursors) {
        const { [socketId]: _gone, ...rest } = cursors;
        set(rest);
      }
    },
    /** Forgets the pointers of everyone not in `socketIds`. */
    keepOnly(socketIds) {
      const present = new Set(socketIds);
      const kept = Object.entries(cursors).filter(([id]) => present.has(id));
      if (kept.length !== Object.keys(cursors).length) set(Object.fromEntries(kept));
    },
    clear() {
      if (cursors !== NONE) set(NONE);
    },
  };
}

/** A store with nobody in it, for boards that have no collaborators. */
export const noCursors = createCursorStore();

export function useCursors(store) {
  return useSyncExternalStore(store.subscribe, store.getSnapshot);
}
