import { useEffect, useMemo, useRef, useState } from "react";
import { toast } from "sonner";
import { getGuest } from "../../lib/guest";
import { createBoardStore } from "./store";

// A guest's board lives in this browser only (localStorage), so anyone can start
// drawing without an account and nothing reaches the database. Signing up
// uploads it as their first real board (see DrawPage).

const SCRATCH_KEY = "inkboard.scratch";
const SAVE_DELAY_MS = 400;

export function readScratch() {
  try {
    const stored = JSON.parse(localStorage.getItem(SCRATCH_KEY) ?? "null");
    if (stored && Array.isArray(stored.elements)) {
      return { title: typeof stored.title === "string" ? stored.title : "Untitled board", elements: stored.elements };
    }
  } catch {
    // Missing, unreadable or blocked storage: start with an empty board.
  }
  return { title: "Untitled board", elements: [] };
}

function writeScratch(scratch) {
  try {
    localStorage.setItem(SCRATCH_KEY, JSON.stringify(scratch));
    return true;
  } catch {
    return false;
  }
}

export function clearScratch() {
  try {
    localStorage.removeItem(SCRATCH_KEY);
  } catch {
    // Nothing to clear.
  }
}

const NOOP = () => {};
const NO_PEOPLE = [];
const NO_CURSORS = {};

/**
 * Everything BoardEditor needs for a board that has no server: a store loaded
 * from, and saved to, localStorage, and a stand-in for the live-sync object.
 */
export function useScratchBoard() {
  const store = useMemo(() => createBoardStore(), []);
  const [title, setTitle] = useState(() => readScratch().title);
  const titleRef = useRef(title);

  useEffect(() => {
    store.load(readScratch().elements);

    let timer = null;
    let warned = false;

    const save = () => {
      clearTimeout(timer);
      timer = null;
      if (!writeScratch({ title: titleRef.current, elements: store.getElements() }) && !warned) {
        warned = true;
        toast.error("This browser can't store more. Save your board to keep it.");
      }
    };
    const unsubscribe = store.subscribe(() => {
      timer ??= setTimeout(save, SAVE_DELAY_MS);
    });
    // Closing the tab can beat the debounce, so write out whatever is pending.
    const flush = () => timer && save();
    window.addEventListener("pagehide", flush);
    document.addEventListener("visibilitychange", flush);

    return () => {
      unsubscribe();
      window.removeEventListener("pagehide", flush);
      document.removeEventListener("visibilitychange", flush);
      flush();
    };
  }, [store]);

  const sync = useMemo(() => {
    const guest = getGuest();
    return {
      phase: { name: "ready" },
      meta: { id: "local", title, owner: { id: guest.id, name: guest.name }, collaborators: [], linkAccess: "restricted" },
      setMeta: (update) => {
        const next = typeof update === "function" ? update({ title }) : update;
        if (typeof next.title !== "string" || next.title === title) return;
        titleRef.current = next.title;
        setTitle(next.title);
        writeScratch({ title: next.title, elements: store.getElements() });
      },
      role: "owner",
      peers: NO_PEOPLE,
      cursors: NO_CURSORS,
      online: true,
      saving: false,
      sendCursor: NOOP,
      sendViewport: NOOP,
      subscribeViewport: () => NOOP,
      requestViewport: NOOP,
      socket: null,
    };
  }, [title, store]);

  return { store, sync };
}
