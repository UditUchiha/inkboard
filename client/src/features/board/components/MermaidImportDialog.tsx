import type { Element as BoardElement } from "@inkboard/shared/types";
import { useEffect, useState } from "react";
import type { FormEvent } from "react";
import { Button } from "../../../components/Button";
import { Dialog } from "../../../components/Dialog";
import { measureText } from "../lib/elements/elements";
import { MermaidError, mermaidToElements } from "../lib/mermaid/mermaid";
import type { Measure } from "../lib/mermaid/mermaid";

type MermaidImportDialogProps = {
  open: boolean;
  onClose: () => void;
  getCentre: () => { x: number; y: number };
  onImported: (elements: BoardElement[], skipped: string[]) => void;
};

// Labels measured as the board draws them, so they sit in the middle of their shapes.
const measure: Measure = (text, fontSize) => measureText({ fontSize, font: "hand" }, text);

export function MermaidImportDialog({ open, onClose, getCentre, onImported }: MermaidImportDialogProps) {
  const [text, setText] = useState("");
  const [error, setError] = useState("");

  useEffect(() => {
    if (open) setError("");
  }, [open]);

  function submit(event: FormEvent<HTMLFormElement>) {
    event.preventDefault();
    try {
      const { elements, skipped } = mermaidToElements(text, getCentre(), measure);
      onImported(elements, skipped);
      setText("");
      onClose();
    } catch (importError) {
      if (!(importError instanceof MermaidError)) throw importError;
      setError(importError.message);
    }
  }

  return (
    <Dialog
      open={open}
      onClose={onClose}
      title="Import Mermaid"
      description="Paste a Mermaid flowchart or sequence diagram. It's laid out on the board as shapes and arrows you can edit."
    >
      <form onSubmit={submit} className="grid gap-4">
        <label className="grid gap-1.5">
          <span className="sr-only">Mermaid diagram</span>
          <textarea
            value={text}
            onChange={(event) => setText(event.target.value)}
            rows={9}
            required
            autoFocus
            spellCheck={false}
            placeholder={
              "flowchart LR\n  start([Sign up]) --> form[Fill in the form]\n  form --> check{Email ok?}\n  check -->|yes| done[Welcome]"
            }
            className="w-full resize-y rounded-lg border border-rule bg-surface px-3 py-2 font-mono text-sm text-ink placeholder:text-graphite/70 hover:border-graphite/60 focus:border-signal focus:ring-3 focus:ring-signal/20 focus:outline-none"
          />
        </label>
        {error && (
          <p role="alert" className="text-sm text-danger">
            {error}
          </p>
        )}
        <div className="flex justify-end gap-2">
          <Button variant="secondary" onClick={onClose}>
            Cancel
          </Button>
          <Button type="submit" disabled={!text.trim()}>
            Import
          </Button>
        </div>
      </form>
    </Dialog>
  );
}
