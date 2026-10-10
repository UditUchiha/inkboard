import { useEffect, useRef, useState } from "react";
import { toast } from "sonner";
import type { ApiError } from "../../lib/api";
import { isComposing } from "./mentions";
import { titleToSave } from "./titleEdit";

/** What a rename leaves the board's details as: at least its new title. */
export type RenamedBoard = { title: string };

/** What the board title takes: the board, how to rename it, and what to do with the board once it is. */
export type BoardTitleProps = {
  board: { title: string };
  rename: (title: string) => Promise<RenamedBoard>;
  onRenamed: (updated: RenamedBoard) => void;
  readOnly: boolean;
};

/** The board's name: an input for people who can edit it (`rename` saves it), plain text for viewers. */
export function BoardTitle({ board, rename, onRenamed, readOnly }: BoardTitleProps) {
  const [title, setTitle] = useState(board.title);
  // The name the field showed when typing in it began, or null before then. Only focusing the field
  // doesn't count, so a rename someone else makes still shows, and leaving the field doesn't undo it.
  const base = useRef<string | null>(null);
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
      // Whatever `rename` throws is an ApiError (it is how the server refuses).
      toast.error((error as ApiError).message);
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
          // `currentTarget` is cleared by the time this runs; the key was pressed in the input, so `target` is it.
          requestAnimationFrame(() => (event.target as HTMLInputElement).blur());
        }
      }}
      maxLength={80}
      aria-label="Board title"
      className="h-10 w-[clamp(7rem,24vw,16rem)] truncate rounded-lg bg-transparent px-2 font-semibold transition-colors hover:bg-ink/5 focus:bg-surface-2 focus:outline-none"
    />
  );
}
