import { useEffect, useState } from "react";
import { Button } from "../../components/Button";
import { Dialog } from "../../components/Dialog";
import { TextField } from "../../components/Field";
import { api } from "../../lib/api";

export function RenameDialog({ board, onClose, onRenamed }) {
  const [title, setTitle] = useState(board?.title ?? "");
  const [saving, setSaving] = useState(false);
  const [error, setError] = useState("");

  useEffect(() => {
    setTitle(board?.title ?? "");
    setError("");
  }, [board]);

  async function submit(event) {
    event.preventDefault();
    setSaving(true);
    try {
      const { board: updated } = await api.renameBoard(board.id, title);
      onRenamed(updated);
      onClose();
    } catch (renameError) {
      setError(renameError.message);
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
