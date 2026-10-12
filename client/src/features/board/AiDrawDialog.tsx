import { Sparkles } from "lucide-react";
import type { Element as BoardElement } from "@inkboard/shared/types";
import { useEffect, useRef, useState } from "react";
import type { FormEvent } from "react";
import { Button } from "../../components/Button";
import { Dialog } from "../../components/Dialog";
import { PasswordField } from "../../components/Field";
import { AI_MODEL, AiDrawError, drawWithAi, readAiKey, saveAiKey } from "./aiDraw";
import type { Rect } from "./geometry";

type AiDrawDialogProps = {
  open: boolean;
  onClose: () => void;
  // The board as it is now, and the part of it on screen, which Claude is told about.
  getBoard: () => BoardElement[];
  getView: () => Rect;
  // Puts what Claude drew on the board, and says how many elements couldn't be drawn.
  onDrawn: (elements: BoardElement[], skipped: number) => void;
};

/**
 * Draw with AI: the person describes what they want and Claude draws it, with their own Anthropic key (see
 * aiDraw.ts). The key is asked for once and kept in this browser.
 */
export function AiDrawDialog({ open, onClose, getBoard, getView, onDrawn }: AiDrawDialogProps) {
  const [key, setKey] = useState(readAiKey);
  const [changingKey, setChangingKey] = useState(false);
  const [request, setRequest] = useState("");
  const [error, setError] = useState("");
  const [drawing, setDrawing] = useState(false);
  const abort = useRef<AbortController | null>(null);
  const asksForKey = !key || changingKey;

  useEffect(() => {
    if (!open) abort.current?.abort(); // closing cancels a drawing under way
    setError("");
  }, [open]);

  async function draw(event: FormEvent<HTMLFormElement>) {
    event.preventDefault();
    const form = new FormData(event.currentTarget);
    const typedKey = String(form.get("key") ?? "").trim();
    const useKey = asksForKey ? typedKey : key;
    if (asksForKey) {
      saveAiKey(typedKey);
      setKey(typedKey);
      setChangingKey(false);
    }
    setError("");
    setDrawing(true);
    abort.current = new AbortController();
    try {
      const { elements, skipped } = await drawWithAi({
        key: useKey,
        request: request.trim(),
        board: getBoard(),
        view: getView(),
        signal: abort.current.signal,
      });
      if (elements.length === 0) {
        setError("Claude didn't draw anything for that. Try saying more about what you want.");
        return;
      }
      onDrawn(elements, skipped);
      setRequest("");
      onClose();
    } catch (drawError) {
      if (drawError instanceof DOMException && drawError.name === "AbortError") return;
      setError(drawError instanceof AiDrawError ? drawError.message : "Something went wrong. Try again.");
    } finally {
      setDrawing(false);
    }
  }

  return (
    <Dialog
      open={open}
      onClose={onClose}
      title="Draw with AI"
      description="Describe what to draw, and Claude adds it to the board. You can undo it like anything else."
    >
      <form onSubmit={draw} className="grid gap-4">
        {asksForKey && (
          <div className="grid gap-1.5">
            <PasswordField
              name="key"
              label="Your Anthropic API key"
              autoComplete="off"
              defaultValue={key}
              placeholder="sk-ant-…"
              required
            />
            <p className="text-sm text-graphite">
              It's kept only in this browser and sent only to Anthropic, which bills your account. Make one at{" "}
              <a
                href="https://console.anthropic.com/settings/keys"
                target="_blank"
                rel="noopener"
                className="underline"
              >
                console.anthropic.com
              </a>
              .
            </p>
          </div>
        )}
        <label className="grid gap-1.5">
          <span className="text-sm font-medium">What should Claude draw?</span>
          <textarea
            value={request}
            onChange={(event) => setRequest(event.target.value)}
            onKeyDown={(event) => {
              // Ctrl or ⌘ + Enter draws, as in a chat box; Enter alone makes a new line.
              if (event.key === "Enter" && (event.ctrlKey || event.metaKey)) event.currentTarget.form?.requestSubmit();
            }}
            rows={4}
            maxLength={4000}
            required
            autoFocus
            placeholder="A flowchart of someone signing up: the form, checking their email, and the welcome screen"
            className="w-full resize-y rounded-lg border border-rule bg-surface px-3 py-2 text-[15px] text-ink placeholder:text-graphite/70 hover:border-graphite/60 focus:border-signal focus:ring-3 focus:ring-signal/20 focus:outline-none"
          />
        </label>
        {error && (
          <p role="alert" className="text-sm text-danger">
            {error}
          </p>
        )}
        <div className="flex flex-wrap items-center justify-between gap-2">
          <p className="text-xs text-graphite">
            {AI_MODEL}
            {!asksForKey && (
              <>
                {" · "}
                <button type="button" onClick={() => setChangingKey(true)} className="underline">
                  Change key
                </button>
                {" · "}
                {/* For a shared computer: the key leaves this browser. */}
                <button
                  type="button"
                  onClick={() => {
                    saveAiKey("");
                    setKey("");
                  }}
                  className="underline"
                >
                  Forget key
                </button>
              </>
            )}
          </p>
          <div className="flex gap-2">
            <Button variant="secondary" onClick={drawing ? () => abort.current?.abort() : onClose}>
              {drawing ? "Stop" : "Cancel"}
            </Button>
            <Button type="submit" icon={Sparkles} loading={drawing} disabled={!request.trim()}>
              {drawing ? "Drawing…" : "Draw"}
            </Button>
          </div>
        </div>
      </form>
    </Dialog>
  );
}
