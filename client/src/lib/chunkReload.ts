import { lazy } from "react";
import type { ComponentType } from "react";

// After a deploy a tab's earlier code files are gone, so opening a page it hasn't loaded fails; reloading fetches the
// new version.
// Recent reloads are remembered so a truly missing file shows the error page instead of looping: no second reload
// within
// seconds, and no more than a couple within minutes (a download that hangs before failing would slip past the first
// limit).
const RELOAD_KEY = "inkboard.chunkReloads";
const RELOAD_WAIT = 10_000;
const RELOAD_WINDOW = 300_000;
const RELOAD_MAX = 2;

let reloading = false;

// What Chrome, Firefox and Safari say when a dynamic import() fails, and what Vite says when preloading a file does.
const CHUNK_ERRORS = [
  /Failed to fetch dynamically imported module/i,
  /error loading dynamically imported module/i,
  /Importing a module script failed/i,
  /Unable to preload CSS/i,
];

type ErrorLike = { name?: unknown; message?: unknown } | null | undefined;

export function isChunkLoadError(error: ErrorLike) {
  const message = typeof error?.message === "string" ? error.message : "";
  return error?.name === "ChunkLoadError" || CHUNK_ERRORS.some((pattern) => pattern.test(message));
}

function readReloads(store: Pick<Storage, "getItem">): number[] {
  try {
    const times: unknown = JSON.parse(store.getItem(RELOAD_KEY)!);
    return Array.isArray(times) ? times.filter(Number.isFinite) : [];
  } catch {
    return [];
  }
}

type ReloadOptions = {
  storage?: () => Pick<Storage, "getItem" | "setItem">;
  now?: number;
  reload?: () => void;
};

export function reloadOnce({
  storage = () => globalThis.sessionStorage,
  now = Date.now(),
  reload = () => window.location.reload(),
}: ReloadOptions = {}) {
  if (reloading) return true;
  try {
    const recent = readReloads(storage()).filter((time) => now - time >= 0 && now - time < RELOAD_WINDOW);
    if (recent.length >= RELOAD_MAX || (recent.length > 0 && now - Math.max(...recent) < RELOAD_WAIT)) return false;
    storage().setItem(RELOAD_KEY, JSON.stringify([...recent, now]));
  } catch {
    // Without session storage there is no way to tell a reload loop apart, so don't risk one.
    return false;
  }
  reloading = true;
  reload();
  return true;
}

export const resetReloadOnce = () => {
  reloading = false;
};

export function withReload<T>(load: () => Promise<T>, reload: () => boolean = reloadOnce) {
  return () =>
    load().catch((error: ErrorLike) => {
      // Keep showing the loading state while the page reloads.
      if (isChunkLoadError(error) && reload()) return new Promise<never>(() => {});
      throw error;
    });
}

// React.lazy remembers a failed load for good, so a page whose code file is gone after a deploy reloads the app once
// instead.
export const lazyPage = <T extends ComponentType>(load: () => Promise<{ default: T }>) => lazy(withReload(load));
