// What a keyboard or drag event's target is, for deciding whether the board's shortcuts apply.

// Where keys are for typing, not the board's shortcuts: not a color picker, slider or checkbox, which have no use for them.
const TEXT_INPUTS = new Set(["text", "search", "email", "url", "tel", "password", "number"]);

export const isTypingTarget = (target) =>
  target instanceof HTMLElement &&
  (target.isContentEditable ||
    /^(TEXTAREA|SELECT)$/.test(target.tagName) ||
    (target.tagName === "INPUT" && TEXT_INPUTS.has(target.type)));

// Controls that Space and Enter work by themselves: they press a button, open a color picker, tick a box.
const PRESSABLE = [
  "button",
  "a[href]",
  "summary",
  "[role='button']",
  ...["color", "checkbox", "radio", "file", "button", "submit", "reset"].map((type) => `input[type='${type}']`),
].join(", ");

export const isPressable = (target) => target instanceof HTMLElement && Boolean(target.closest(PRESSABLE));

/**
 * True when keys belong to something open over the board rather than to its shortcuts: a menu or a
 * modal dialog wherever focus is, or a popover (a comment) when focus is inside it. Focus back on the
 * board gives the shortcuts back even with a popover still open, and the popover handles its own Escape.
 */
export const isOverlayKey = (target, root = document) =>
  Boolean(root.querySelector("dialog[open], [role='menu'], [aria-modal='true']")) ||
  (target instanceof HTMLElement && Boolean(target.closest("[role='dialog']")));
