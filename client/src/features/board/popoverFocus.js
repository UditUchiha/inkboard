/**
 * Where focus should go when a popover closes: back to what opened it, but only if focus was inside the popover at
 * that moment. Focus sitting on the page body doesn't count: clicking the canvas deliberately blurs to the body, and
 * sending focus back to a pin then would make the next Space (pan) or Enter press that pin and reopen its thread.
 */
export function focusAfterClose(popover, active, opener) {
  if (!popover || !active || !popover.contains(active)) return null;
  return opener?.isConnected ? opener : null;
}
