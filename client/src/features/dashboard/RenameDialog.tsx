import { useEffect, useState } from "react";
import type { SubmitEvent } from "react";
import { Button } from "../../components/Button";
import { Dialog } from "../../components/Dialog";
import { TextField } from "../../components/Field";
import { api } from "../../lib/api";
import type { ApiError } from "../../lib/api";
import type { BoardSummary } from "./sections";

// What the server answers a rename with, of which the dashboard keeps the new title and time.
type RenamedBoard = Pick<BoardSummary, "id" | "title" | "updatedAt">;

type RenameDialogProps = {
  /** The board being renamed; the dialog is open while there is one. */
  board: BoardSummary | null;
  onClose: () => void;
  onRenamed: (board: RenamedBoard) => void;
};

export function RenameDialog({ board, onClose, onRenamed }: RenameDialogProps) {
  const [title, setTitle] = useState(board?.title ?? "");
  const [saving, setSaving] = useState(false);
  const [error, setError] = useState("");

  useEffect(() => {
    setTitle(board?.title ?? "");
    setError("");
  }, [board]);

  async function submit(event: SubmitEvent<HTMLFormElement>) {
    event.preventDefault();
    setSaving(true);
    try {
      // The form can only be sent while the dialog is open, which is while there is a board. renameBoard doesn't
      // say what it answers with yet.
      const { board: updated } = (await api.renameBoard(board!.id, title)) as { board: RenamedBoard };
      onRenamed(updated);
      onClose();
    } catch (renameError) {
      setError((renameError as ApiError).message); // requests only fail with an ApiError
    } finally {
      setSaving(false);
    }
  }

  return (
    <Dialog open={Boolean(board)} onClose={onClose} title="Rename board">
      <form onSubmit={submit} className="grid gap-5">
        <TextField
          label="Title"
          value={title}
          onChange={(event) => setTitle(event.target.value)}
          maxLength={80}
          error={error}
          autoFocus
          required
        />
        <div className="flex justify-end gap-2">
          <Button variant="secondary" onClick={onClose}>
            Cancel
          </Button>
          <Button type="submit" loading={saving} disabled={!title.trim()}>
            Save
          </Button>
        </div>
      </form>
    </Dialog>
  );
}
