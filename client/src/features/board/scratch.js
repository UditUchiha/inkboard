import { cleanElement } from "@inkboard/shared/element-rules";
import { useEffect, useMemo, useRef, useState } from "react";
import { toast } from "sonner";
import { getGuest } from "../../lib/guest";
import { noCursors } from "./cursors";
import { createEditorStore } from "./editorStore";

// A guest's board lives in this browser only (localStorage), so anyone can start
// drawing without an account and nothing reaches the database. Signing up
// uploads it as their first real board (see DrawPage).

const SCRATCH_KEY = "inkboard.scratch";
const SAVE_DELAY_MS = 400;
const FULL_WARNING_EVERY_MS = 20_000;

/** The saved scratch board. Anything in it that isn't a valid element is left out, so it can't break drawing. */
export function readScratch() {
  try {
    const stored = JSON.parse(localStorage.getItem(SCRATCH_KEY) ?? "null");
    if (stored && Array.isArray(stored.elements)) {
      return {
        title: typeof stored.title === "string" ? stored.title : "Untitled board",
        elements: stored.elements.map(cleanElement).filter(Boolean),
      };
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

// The drawing as it is in this tab. When the browser has no room left, what's in
// localStorage is out of date, and what is uploaded on signing up must be this.
let live = null;

/** The scratch board to show or upload: this tab's own drawing if it made one, otherwise what was saved. */
export function currentScratch() {
  return live ?? readScratch();
}

export function clearScratch() {
  live = null;
  try {
    localStorage.removeItem(SCRATCH_KEY);
  } catch {
    // Nothing to clear.
  }
}

const NOOP = () => {};
const NO_PEOPLE = [];

/**
 * Everything BoardEditor needs for a board that has no server: a store loaded
 * from, and saved to, localStorage, and a stand-in for the live-sync object.
 */
export function useScratchBoard() {
  const store = useMemo(createEditorStore, []);
  const [title, setTitle] = useState(() => currentScratch().title);
  const [unsaved, setUnsaved] = useState(false); // the browser had no room to keep the latest changes
  const titleRef = useRef(title);

  useEffect(() => {
    store.load(currentScratch().elements);

    let timer = null;
    let lastWarning = 0;
    let adopting = false; // showing what another tab saved: not a change to save again

    const remember = () => {
      live = { title: titleRef.current, elements: store.getElements() };
    };
    const save = () => {
      clearTimeout(timer);
      timer = null;
      const kept = writeScratch({ title: titleRef.current, elements: store.getElements() });
      setUnsaved(!kept);
      if (!kept && Date.now() - lastWarning > FULL_WARNING_EVERY_MS) {
        lastWarning = Date.now();
        toast.error("This browser has no room left to keep your drawing. Save your board to your account to keep it.", {
          id: "scratch-full",
        });
      }
    };
    const unsubscribe = store.subscribe(() => {
      if (adopting) return;
      remember();
      timer ??= setTimeout(save, SAVE_DELAY_MS);
    });
    // Closing the tab can beat the debounce, so write out whatever is pending.
    const flush = () => timer && save();
    window.addEventListener("pagehide", flush);
    document.addEventListener("visibilitychange", flush);

    // Another tab changed the drawing (or saved it to an account, which clears it): show that,
    // rather than carrying on with a copy that would overwrite it, or upload it a second time.
    const onStorage = (event) => {
      if (event.key !== SCRATCH_KEY && event.key !== null) return;
      clearTimeout(timer);
      timer = null;
      live = null;
      const scratch = readScratch();
      titleRef.current = scratch.title;
      setTitle(scratch.title);
      adopting = true;
      store.load(scratch.elements);
      adopting = false;
    };
    window.addEventListener("storage", onStorage);

    return () => {
      unsubscribe();
      window.removeEventListener("pagehide", flush);
      document.removeEventListener("visibilitychange", flush);
      window.removeEventListener("storage", onStorage);
      flush();
    };
  }, [store]);

  const sync = useMemo(() => {
    const guest = getGuest();
    return {
      phase: { name: "ready" },
      meta: {
        id: "local",
        title,
        owner: { id: guest.id, name: guest.name },
        collaborators: [],
        linkAccess: "restricted",
      },
      setMeta: (update) => {
        const next = typeof update === "function" ? update({ title }) : update;
        if (typeof next.title !== "string" || next.title === title) return;
        titleRef.current = next.title;
        setTitle(next.title);
        live = { title: next.title, elements: store.getElements() };
        setUnsaved(!writeScratch(live));
      },
      role: "owner",
      peers: NO_PEOPLE,
      cursors: noCursors,
      online: true,
      saving: false,
      unsaved,
      sendCursor: NOOP,
      sendViewport: NOOP,
      subscribeViewport: () => NOOP,
      requestViewport: NOOP,
      socket: null,
    };
  }, [title, unsaved, store]);

  return { store, sync };
}
