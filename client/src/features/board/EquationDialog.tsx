import { Sigma } from "lucide-react";
import type { PenElement } from "@inkboard/shared/types";
import { useEffect, useMemo, useReducer, useState } from "react";
import { Button } from "../../components/Button";
import { Dialog } from "../../components/Dialog";
import { AI_MODEL, AiDrawError, readAiKey } from "./aiDraw";
import { pictureOf, readHandwriting } from "./handwriting";
import { formulaOf, formulaSvg, onFormulasChanged } from "./math";

type EquationDialogProps = {
  // The strokes being read; the dialog is open while there are some.
  strokes: PenElement[] | null;
  onClose: () => void;
  // Replaces the strokes with the equation written as `latex`.
  onInsert: (latex: string) => void;
};

/**
 * Convert to equation: Claude reads the selected handwriting as LaTeX (see handwriting.ts), and the person sees it
 * typeset, can correct it, and inserts it in place of the strokes. Opened only when there's an Anthropic key.
 */
export function EquationDialog({ strokes, onClose, onInsert }: EquationDialogProps) {
  const picture = useMemo(() => (strokes ? pictureOf(strokes) : ""), [strokes]);
  const [latex, setLatex] = useState("");
  const [error, setError] = useState("");
  const [reading, setReading] = useState(false);

  // Reads the writing as soon as the dialog opens; closing it cancels the request.
  useEffect(() => {
    if (!picture) return;
    const abort = new AbortController();
    setLatex("");
    setError("");
    setReading(true);
    readHandwriting({ key: readAiKey(), picture, signal: abort.signal })
      .then(setLatex)
      .catch((readError: unknown) => {
        if (readError instanceof DOMException && readError.name === "AbortError") return;
        setError(readError instanceof AiDrawError ? readError.message : "Something went wrong. Try again.");
      })
      .finally(() => {
        if (!abort.signal.aborted) setReading(false);
      });
    return () => abort.abort();
  }, [picture]);

  return (
    <Dialog
      open={Boolean(strokes)}
      onClose={onClose}
      title="Convert to equation"
      description="Claude reads your handwriting as LaTeX. Check it, and correct it if it's wrong, before it replaces what you wrote."
    >
      <form
        className="grid gap-4"
        onSubmit={(event) => {
          event.preventDefault();
          onInsert(latex.trim());
        }}
      >
        <figure className="grid gap-1.5">
          <img
            src={picture}
            alt="Your handwriting, as Claude sees it"
            className="max-h-32 w-full rounded-lg border border-rule bg-white object-contain p-2"
          />
          <figcaption className="text-xs text-graphite">What Claude reads</figcaption>
        </figure>
        <label className="grid gap-1.5">
          <span className="text-sm font-medium">LaTeX</span>
          <textarea
            value={latex}
            onChange={(event) => setLatex(event.target.value)}
            rows={3}
            disabled={reading}
            placeholder={reading ? "Reading…" : String.raw`\frac{a}{b}`}
            spellCheck={false}
            className="w-full resize-y rounded-lg border border-rule bg-surface px-3 py-2 font-mono text-sm text-ink placeholder:text-graphite/70 hover:border-graphite/60 focus:border-signal focus:ring-3 focus:ring-signal/20 focus:outline-none disabled:opacity-60"
          />
        </label>
        {latex.trim() && <Typeset tex={latex.trim()} />}
        {error && (
          <p role="alert" className="text-sm text-danger">
            {error}
          </p>
        )}
        <div className="flex flex-wrap items-center justify-between gap-2">
          <p className="text-xs text-graphite">{AI_MODEL}</p>
          <div className="flex gap-2">
            <Button variant="secondary" onClick={onClose}>
              Cancel
            </Button>
            <Button type="submit" icon={Sigma} loading={reading} disabled={!latex.trim()}>
              {reading ? "Reading…" : "Insert"}
            </Button>
          </div>
        </div>
      </form>
    </Dialog>
  );
}

// The equation as it will look on the board, typeset by MathJax the way the board does it.
function Typeset({ tex }: { tex: string }) {
  const [, redraw] = useReducer((count: number) => count + 1, 0);
  useEffect(() => onFormulasChanged(redraw), []);
  const formula = formulaOf(`$$${tex}$$`);
  return (
    <div
      aria-live="polite"
      className="grid min-h-16 place-items-center overflow-x-auto rounded-lg border border-rule bg-white p-3"
    >
      {formula ? (
        <img
          src={`data:image/svg+xml;charset=utf-8,${encodeURIComponent(
            formulaSvg(formula, "#16213a", Math.ceil(formula.width * 24), Math.ceil(formula.height * 24)),
          )}`}
          alt={tex}
          className="max-w-full"
        />
      ) : (
        <span className="text-sm text-graphite">Typesetting…</span>
      )}
    </div>
  );
}
