import { lazy } from "react";
import type { ComponentType } from "react";

// After a deploy, the code files a tab loaded earlier are gone from the server, so the first time that tab opens a
// page it hasn't loaded yet, the download fails. Loading the page again fetches the new version. The times of this
// tab's recent reloads are kept, so a file that is truly missing (or a server that is down) shows the error page
// instead of reloading forever; a later deploy, after the wait, can reload again. Two limits: no second reload within
// a few seconds (a loop that fails fast), and no more than a couple within a few minutes (a download that hangs for
// a while before failing would otherwise get past the first limit every time).
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

// Anything a failed import() may reject with: only its name and message are looked at.
type ErrorLike = { name?: unknown; message?: unknown } | null | undefined;

/** Whether `error` is a failed download of one of the app's own code files, which reloading fixes. */
export function isChunkLoadError(error: ErrorLike) {
  const message = typeof error?.message === "string" ? error.message : "";
  return error?.name === "ChunkLoadError" || CHUNK_ERRORS.some((pattern) => pattern.test(message));
}

/** The times (ms) of this tab's earlier reloads, ignoring anything in storage that isn't a list of numbers. */
function readReloads(store: Pick<Storage, "getItem">): number[] {
  try {
    // Nothing stored (null) reads as the text "null", which isn't a list either, so the `!` changes nothing.
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

/**
 * Reloads the page unless this tab already did so for the same reason a moment ago, or too often lately. Returns whether it is reloading,
 * so the caller can wait for the new page instead of showing an error.
 */
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

/** Forgets that a reload is under way (for tests). */
export const resetReloadOnce = () => {
  reloading = false;
};

/** `load`, except that when the code file is gone after a deploy it reloads the app (once) instead of failing. */
export function withReload<T>(load: () => Promise<T>, reload: () => boolean = reloadOnce) {
  return () =>
    // A failed import() rejects with an Error, which is what ErrorLike describes.
    load().catch((error: ErrorLike) => {
      // Keep showing the loading state while the page reloads.
      if (isChunkLoadError(error) && reload()) return new Promise<never>(() => {});
      throw error;
    });
}

/**
 * Like `React.lazy(load)`, but a page whose code file is gone after a deploy reloads the whole app once instead of
 * failing. React.lazy remembers a failed load for good, so "Try again" alone could never recover from one.
 */
export const lazyPage = <T extends ComponentType>(load: () => Promise<{ default: T }>) => lazy(withReload(load));
