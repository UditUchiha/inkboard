import { useEffect, useRef, useState } from "react";
import { toast } from "sonner";
import { isComposing } from "./mentions";
import { titleToSave } from "./titleEdit";

/** The board's name: an input for people who can edit it (`rename` saves it), plain text for viewers. */
export function BoardTitle({ board, rename, onRenamed, readOnly }) {
  const [title, setTitle] = useState(board.title);
  // The name the field showed when typing in it began, or null before then. Only focusing the field
  // doesn't count, so a rename someone else makes still shows, and leaving the field doesn't undo it.
  const base = useRef(null);
  useEffect(() => {
    if (readOnly) base.current = null; // the field is gone, and what was typed in it with it
    if (base.current === null) setTitle(board.title);
  }, [board.title, readOnly]);

  if (readOnly) {
    return <h1 className="max-w-[clamp(7rem,24vw,16rem)] truncate px-2 font-semibold">{board.title}</h1>;
  }

  async function save() {
    const next = titleToSave(title, { current: board.title, base: base.current });
    base.current = null;
    if (!next) {
      setTitle(board.title);
      return;
    }
    try {
      onRenamed(await rename(next));
    } catch (error) {
      toast.error(error.message);
      setTitle(board.title);
    }
  }

  return (
    <input
      value={title}
      onChange={(event) => {
        base.current ??= title;
        setTitle(event.target.value);
      }}
      onBlur={save}
      onKeyDown={(event) => {
        if (isComposing(event)) return; // Enter and Escape belong to the input method then
        if (event.key === "Enter") event.currentTarget.blur();
        if (event.key === "Escape") {
          base.current = null;
          setTitle(board.title);
          requestAnimationFrame(() => event.target.blur());
        }
      }}
      maxLength={80}
      aria-label="Board title"
      className="h-10 w-[clamp(7rem,24vw,16rem)] truncate rounded-lg bg-transparent px-2 font-semibold transition-colors hover:bg-ink/5 focus:bg-surface-2 focus:outline-none"
    />
  );
}
