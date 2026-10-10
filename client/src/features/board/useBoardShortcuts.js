import { useEffect, useRef } from "react";
import { COMMENT_TOOL, NUMBERED_TOOLS, TOOLS } from "./constants";
import { isConnector } from "./connectors";
import { isOverlayKey, isPressable, isTypingTarget } from "./domTargets";

const ARROW_KEYS = { ArrowUp: [0, -1], ArrowDown: [0, 1], ArrowLeft: [-1, 0], ArrowRight: [1, 0] };

// Tools are reachable by letter (V, P, R…), and the first nine by position (1–9) too.
function toolForKey(key, withComments) {
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
}) {
  const keys = useRef({});
  const withModifier = {
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
  const plain = {
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
      const element = selectedId && store.getElement(selectedId);
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

  function onKeyDown(event) {
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
  const onKeyUp = (event) => event.key === " " && setSpacePressed(false);
  const onBlur = () => setSpacePressed(false);

  keys.current = { onKeyDown, onKeyUp, onBlur };
  useEffect(() => {
    const onKeyDown = (event) => keys.current.onKeyDown(event);
    const onKeyUp = (event) => keys.current.onKeyUp(event);
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
