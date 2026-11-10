import { Sparkles } from "lucide-react";
import type { Element as BoardElement } from "@inkboard/shared/types";
import { useRef, useState } from "react";
import type { FormEvent } from "react";
import { Button } from "../../../components/Button";
import { Dialog } from "../../../components/Dialog";
import { drawWithAi } from "../lib/ai/aiDraw";
import { AiError } from "../lib/ai/askModel";
import { activeKey, activeModel, PROVIDERS, readAiSettings, saveAiSettings } from "../lib/ai/providers";
import type { AiSettings } from "../lib/ai/providers";
import type { Rect } from "../lib/elements/geometry";
import { AiSettingsFields } from "./AiSettingsFields";

interface AiDrawDialogProps {
  open: boolean;
  onClose: () => void;
  getBoard: () => BoardElement[];
  getView: () => Rect;
  onDrawn: (elements: BoardElement[], skipped: number) => void;
}

const trimmed = (settings: AiSettings): AiSettings => ({
  ...settings,
  keys: { ...settings.keys, [settings.provider]: activeKey(settings).trim() },
  models: { ...settings.models, [settings.provider]: (settings.models[settings.provider] ?? "").trim() },
});

export function AiDrawDialog({ open, onClose, getBoard, getView, onDrawn }: AiDrawDialogProps) {
  const [settings, setSettings] = useState(readAiSettings);
  const [editing, setEditing] = useState(() => !activeKey(readAiSettings()));
  const [request, setRequest] = useState("");
  const [error, setError] = useState("");
  const [drawing, setDrawing] = useState(false);
  const [wasOpen, setWasOpen] = useState(open);
  const abort = useRef<AbortController | null>(null);
  const provider = PROVIDERS[settings.provider];

  if (open !== wasOpen) {
    setWasOpen(open);
    if (open) setError("");
  }

  const handleClose = () => {
    abort.current?.abort();
    onClose();
  };

  const handleForgetKey = () => {
    const next = { ...settings, keys: { ...settings.keys, [settings.provider]: "" } };
    saveAiSettings(next);
    setSettings(next);
    setEditing(true);
  };

  const handleDraw = async (event: FormEvent<HTMLFormElement>) => {
    event.preventDefault();
    const used = trimmed(settings);
    if (editing) {
      saveAiSettings(used);
      setSettings(used);
      setEditing(false);
    }
    setError("");
    setDrawing(true);
    abort.current = new AbortController();
    try {
      const { elements, skipped } = await drawWithAi({
        settings: used,
        request: request.trim(),
        board: getBoard(),
        view: getView(),
        signal: abort.current.signal,
      });
      if (elements.length === 0) {
        setError("Nothing was drawn for that. Try saying more about what you want.");
        return;
      }
      onDrawn(elements, skipped);
      setRequest("");
      onClose();
    } catch (drawError) {
      if (drawError instanceof DOMException && drawError.name === "AbortError") return;
      setError(drawError instanceof AiError ? drawError.message : "Something went wrong. Try again.");
    } finally {
      setDrawing(false);
    }
  };

  return (
    <Dialog
      open={open}
      onClose={handleClose}
      title="Draw with AI"
      description="Describe what to draw, and the AI adds it to the board. You can undo it like anything else."
    >
      <form onSubmit={handleDraw} className="grid gap-4">
        {editing && <AiSettingsFields settings={settings} onChange={setSettings} />}
        <label className="grid gap-1.5">
          <span className="text-sm font-medium">What should it draw?</span>
          <textarea
            value={request}
            onChange={(event) => setRequest(event.target.value)}
            onKeyDown={(event) => {
              // Ctrl/⌘ + Enter draws, as in a chat box; Enter alone makes a new line.
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
            {provider.label} · {activeModel(settings)}
            {!editing && (
              <>
                {" · "}
                <button type="button" onClick={() => setEditing(true)} className="underline">
                  Change
                </button>
                {" · "}
                <button type="button" onClick={handleForgetKey} className="underline">
                  Forget key
                </button>
              </>
            )}
          </p>
          <div className="flex gap-2">
            <Button variant="secondary" onClick={drawing ? () => abort.current?.abort() : handleClose}>
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
