import type { Element as BoardElement, StackMove } from "@inkboard/shared/types";
import { useEffect, useRef } from "react";
import type { RefObject } from "react";
import { COMMENT_TOOL, NUMBERED_TOOLS, TOOLS } from "./constants";
import type { Tool, ToolId } from "./constants";
import { isConnector } from "./connectors";
import { isOverlayKey, isPressable, isTypingTarget } from "./domTargets";
import type { BoardStore } from "./store";

const ARROW_KEYS: Record<string, [dx: number, dy: number]> = {
  ArrowUp: [0, -1],
  ArrowDown: [0, 1],
  ArrowLeft: [-1, 0],
  ArrowRight: [1, 0],
};

/** What the keys do. Each can change every render (see useBoardShortcuts). */
export type ShortcutActions = {
  duplicateSelected: () => void;
  moveSelected: (where: StackMove) => void;
  deleteSelected: () => void;
  nudgeSelected: (dx: number, dy: number) => void;
  zoomBy: (factor: number) => void;
  resetZoom: () => void;
  fitToScreen: () => void;
  changeTool: (id: ToolId) => void;
  stopFollowing: () => void;
};

/**
 * What useBoardShortcuts takes. The setters are typed by what the shortcuts pass them (a state setter fits),
 * and `fileInput` is the hidden input the "I" key opens.
 */
export type ShortcutOptions = {
  store: BoardStore;
  readOnly: boolean;
  canComment: boolean;
  canAddImages: boolean;
  selectedId: string | null;
  fileInput: RefObject<HTMLInputElement | null>;
  actions: ShortcutActions;
  setSpacePressed: (pressed: boolean) => void;
  setSelectedId: (id: null) => void;
  setDraft: (draft: null) => void;
  setActiveThread: (id: null) => void;
  setEditing: (editing: { element: BoardElement; isNew: boolean }) => void;
  setDialog: (dialog: "shortcuts") => void;
};

// What the listeners are, kept in a ref so they always read the latest render's.
type KeyHandlers = {
  onKeyDown: (event: KeyboardEvent) => void;
  onKeyUp: (event: KeyboardEvent) => void;
  onBlur: () => void;
};

// Tools are reachable by letter (V, P, R…), and the first nine by position (1–9) too.
function toolForKey(key: string, withComments: boolean): Tool | null {
  const byLetter = (withComments ? [...TOOLS, COMMENT_TOOL] : TOOLS).find((item) => item.key === key);
  if (byLetter) return byLetter;
  return /^[1-9]$/.test(key) && Number(key) <= NUMBERED_TOOLS ? TOOLS[Number(key) - 1] : null;
}

/**
 * The board's keyboard shortcuts. `actions` are what the keys do (each can change every render);
 * the rest says what the board is like now. The listeners are bound once and read the latest
 * of all of it through a ref, so they aren't taken off and put back on every render.
 */
export function useBoardShortcuts({
  store,
  readOnly,
  canComment,
  canAddImages,
  selectedId,
  fileInput,
  actions: {
    duplicateSelected,
    moveSelected,
    deleteSelected,
    nudgeSelected,
    zoomBy,
    resetZoom,
    fitToScreen,
    changeTool,
    stopFollowing,
  },
  setSpacePressed,
  setSelectedId,
  setDraft,
  setActiveThread,
  setEditing,
  setDialog,
}: ShortcutOptions) {
  // The cast: filled in below, on every render, before any key can reach it.
  const keys = useRef({} as KeyHandlers);
  const withModifier: Record<string, (event: KeyboardEvent) => void> = {
    z: (event) => (event.shiftKey ? store.redo() : store.undo()),
    y: () => store.redo(),
    d: duplicateSelected,
    // Shift + ] and Shift + [ read as } and { on most layouts.
    "]": (event) => moveSelected(event.shiftKey ? "front" : "forward"),
    "}": () => moveSelected("front"),
    "[": (event) => moveSelected(event.shiftKey ? "back" : "backward"),
    "{": () => moveSelected("back"),
    "=": () => zoomBy(1.25),
    "+": () => zoomBy(1.25),
    "-": () => zoomBy(0.8),
    0: resetZoom,
  };
  const plain: Record<string, () => void> = {
    " ": () => setSpacePressed(true),
    delete: deleteSelected,
    backspace: deleteSelected,
    escape: () => {
      setSelectedId(null);
      setDraft(null);
      setActiveThread(null);
      stopFollowing();
    },
    i: () => canAddImages && fileInput.current?.click(),
    enter: () => {
      // The cast: an id is never the empty string, so this is an element, or none.
      const element = (selectedId && store.getElement(selectedId)) as BoardElement | null | undefined;
      const editable = element?.type === "text" || element?.type === "sticky" || (element && isConnector(element));
      if (editable) setEditing({ element, isNew: false });
    },
    "?": () => setDialog("shortcuts"),
    "!": fitToScreen, // Shift + 1
  };

  if (readOnly) {
    for (const key of ["z", "y", "d", "]", "}", "[", "{"]) delete withModifier[key];
    for (const key of ["delete", "backspace", "enter"]) delete plain[key];
  }

  function onKeyDown(event: KeyboardEvent) {
    // Not while a menu or dialog has the keys, nor for a key something else already handled (a menu's arrow keys).
    if (event.defaultPrevented || isTypingTarget(event.target) || isOverlayKey(event.target)) return;
    const key = event.key.toLowerCase();

    if (event.ctrlKey || event.metaKey) {
      if (!withModifier[key]) return;
      event.preventDefault();
      withModifier[key](event);
      return;
    }

    if (plain[key]) {
      // Enter on a focused button presses the button, and only that.
      if (key === "enter" && isPressable(event.target)) return;
      // Space presses a focused button or opens a focused color picker, so only elsewhere is its default stopped.
      if (key === " " && !isPressable(event.target)) event.preventDefault();
      plain[key]();
    } else if (ARROW_KEYS[event.key] && selectedId && !readOnly) {
      event.preventDefault();
      const step = event.shiftKey ? 10 : 1;
      nudgeSelected(ARROW_KEYS[event.key][0] * step, ARROW_KEYS[event.key][1] * step);
    } else if (!event.altKey && !readOnly) {
      const next = toolForKey(key, canComment);
      if (next) changeTool(next.id);
    }
  }
  const onKeyUp = (event: KeyboardEvent) => event.key === " " && setSpacePressed(false);
  const onBlur = () => setSpacePressed(false);

  keys.current = { onKeyDown, onKeyUp, onBlur };
  useEffect(() => {
    const onKeyDown = (event: KeyboardEvent) => keys.current.onKeyDown(event);
    const onKeyUp = (event: KeyboardEvent) => keys.current.onKeyUp(event);
    const onBlur = () => keys.current.onBlur();
    window.addEventListener("keydown", onKeyDown);
    window.addEventListener("keyup", onKeyUp);
    window.addEventListener("blur", onBlur);
    return () => {
      window.removeEventListener("keydown", onKeyDown);
      window.removeEventListener("keyup", onKeyUp);
      window.removeEventListener("blur", onBlur);
    };
  }, []);
}
