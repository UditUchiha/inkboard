import { useSyncExternalStore } from "react";
import type { XY } from "../elements/geometry";

export type Cursor = XY & { laser?: true };

export type Cursors = Record<string, Cursor>;

export interface CursorStore {
  subscribe(listener: () => void): () => void;
  getSnapshot(): Cursors;
  move(socketId: string, point?: Cursor | null): void;
  keepOnly(socketIds: Iterable<string>): void;
  clear(): void;
}

// Pointers move about 20 times a second per person, so they live outside React state: only RemoteCursors subscribes and the editor isn't re-rendered.

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
    move(socketId: string, point?: Cursor | null) {
      if (point) {
        set({ ...cursors, [socketId]: point });
      } else if (socketId in cursors) {
        const { [socketId]: _gone, ...rest } = cursors;
        set(rest);
      }
    },
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

export const noCursors = createCursorStore();

export function useCursors(store: CursorStore): Cursors {
  return useSyncExternalStore(store.subscribe, store.getSnapshot);
}
