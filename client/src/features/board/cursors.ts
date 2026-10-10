import { useSyncExternalStore } from "react";
import type { XY } from "./geometry";

/** Where each person's pointer is, by socket id. */
export type Cursors = Record<string, XY>;

/** The store of other people's pointers, for useCursors (see useSyncExternalStore). */
export interface CursorStore {
  subscribe(listener: () => void): () => void;
  getSnapshot(): Cursors;
  move(socketId: string, point?: XY | null): void;
  keepOnly(socketIds: Iterable<string>): void;
  clear(): void;
}

// Where other people's pointers are: socket id -> { x, y } in board coordinates.
// They move about 20 times a second per person, so they live outside React
// state: only the component that draws them (RemoteCursors) subscribes, and the
// editor around it isn't rendered again for each one.

const NONE: Cursors = {};

export function createCursorStore(): CursorStore {
  let cursors = NONE;
  const listeners = new Set<() => void>();
  const set = (next: Cursors) => {
    cursors = next;
    for (const listener of listeners) listener();
  };

  return {
    subscribe(listener: () => void) {
      listeners.add(listener);
      return () => listeners.delete(listener);
    },
    getSnapshot: () => cursors,
    /** Someone's pointer is at `point`; without one, it left the board. */
    move(socketId: string, point?: XY | null) {
      if (point) {
        set({ ...cursors, [socketId]: point });
      } else if (socketId in cursors) {
        const { [socketId]: _gone, ...rest } = cursors;
        set(rest);
      }
    },
    /** Forgets the pointers of everyone not in `socketIds`. */
    keepOnly(socketIds: Iterable<string>) {
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

export function useCursors(store: CursorStore): Cursors {
  return useSyncExternalStore(store.subscribe, store.getSnapshot);
}
