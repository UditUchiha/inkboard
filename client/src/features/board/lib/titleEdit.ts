// `base` is the name the field showed when typing started (null if not typed): a field only clicked into, or typed back to it, still shows
// an old name, and saving that would undo a rename someone else made meanwhile.
export function titleToSave(text: string, { current, base }: { current: string; base: string | null }): string | null {
  const next = text.trim();
  return base !== null && next && next !== base.trim() && next !== current ? next : null;
}
