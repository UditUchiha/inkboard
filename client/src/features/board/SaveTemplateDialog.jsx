import { useEffect, useState } from "react";
import { Button } from "../../components/Button";
import { Dialog } from "../../components/Dialog";
import { TextField } from "../../components/Field";

/** Names a template made from the board as it is now. */
export function SaveTemplateDialog({ open, onClose, defaultTitle, onSave }) {
  const [title, setTitle] = useState(defaultTitle);
  const [saving, setSaving] = useState(false);
  const [error, setError] = useState("");

  useEffect(() => {
    if (open) {
      setTitle(defaultTitle);
      setError("");
    }
  }, [open, defaultTitle]);

  async function submit(event) {
    event.preventDefault();
    setSaving(true);
    try {
      await onSave(title.trim());
      onClose();
    } catch (saveError) {
      setError(saveError.message);
    } finally {
      setSaving(false);
    }
  }

  return (
    <Dialog
      open={open}
      onClose={onClose}
      title="Save as template"
      description="Keep a copy of this board's drawings to start new boards from. Only you can use it."
    >
      <form onSubmit={submit} className="grid gap-5">
        <TextField
          label="Template name"
          value={title}
          onChange={(event) => setTitle(event.target.value)}
          maxLength={60}
          error={error}
          autoFocus
          required
        />
        <div className="flex justify-end gap-2">
          <Button variant="secondary" onClick={onClose}>
            Cancel
          </Button>
          <Button type="submit" loading={saving} disabled={!title.trim()}>
            Save template
          </Button>
        </div>
      </form>
    </Dialog>
  );
}
