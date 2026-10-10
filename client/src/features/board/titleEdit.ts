// What renaming the board from its title field saves. Kept apart from the component so it can be tested.

/**
 * The name to save when the title field lets go of focus, or null to keep the board's `current` name.
 * `base` is the name the field showed when the person started typing, or null if they haven't typed:
 * a field that was merely clicked into, or typed back to what it was, still shows an old name, and
 * saving that would undo a rename someone else made in the meantime.
 */
export function titleToSave(text: string, { current, base }: { current: string; base: string | null }): string | null {
  const next = text.trim();
  return base !== null && next && next !== base.trim() && next !== current ? next : null;
}
