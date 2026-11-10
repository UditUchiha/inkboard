// Focus goes back to what opened the popover only if it was inside it: the canvas deliberately blurs to the body, and refocusing a pin then
// would make the next Space (pan) or Enter press that pin and reopen its thread.
export function focusAfterClose(
  popover: Element | null | undefined,
  active: Element | null | undefined,
  opener: HTMLElement | null | undefined,
): HTMLElement | null {
  if (!popover || !active || !popover.contains(active)) return null;
  return opener?.isConnected ? opener : null;
}
