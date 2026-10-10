import clsx from "clsx";
import { FilePlus2, LoaderCircle, Trash2 } from "lucide-react";
import { useEffect, useMemo, useState } from "react";
import type { ReactNode } from "react";
import { toast } from "sonner";
import { Button, IconButton } from "../../components/Button";
import { Dialog } from "../../components/Dialog";
import type { Element as BoardElement } from "@inkboard/shared/types";
import { api } from "../../lib/api";
import type { ApiError, CreateBoardInput } from "../../lib/api";
import { BoardPreview } from "../board/BoardPreview";
import { BUILTIN_TEMPLATES } from "./builtin";
import type { BuiltinTemplate } from "./builtin";

/** One of the person's own saved templates, as the server lists it (a light preview, not the drawing). */
export type TemplateSummary = {
  id: string;
  title: string;
  elementCount: number;
  preview?: BoardElement[];
  createdAt: string;
};

type ChoiceProps = {
  title: string;
  detail?: string;
  disabled?: boolean;
  onClick: () => void;
  children?: ReactNode;
  action?: ReactNode;
};

function Choice({ title, detail, disabled, onClick, children, action }: ChoiceProps) {
  return (
    <li className="group relative">
      <button
        type="button"
        onClick={onClick}
        disabled={disabled}
        className={clsx(
          "block w-full overflow-hidden rounded-lg border border-rule bg-surface text-left transition-colors hover:border-ink focus-visible:border-ink disabled:opacity-60",
        )}
      >
        <span className="graph-paper block [--cell:14px]">{children}</span>
        <span className="block p-3">
          <span className="block truncate text-sm font-semibold">{title}</span>
          {detail && <span className="block truncate text-xs text-graphite">{detail}</span>}
        </span>
      </button>
      {action}
    </li>
  );
}

type BuiltinChoiceProps = { template: BuiltinTemplate; disabled: boolean; onChoose: (input: CreateBoardInput) => void };

function BuiltinChoice({ template, disabled, onChoose }: BuiltinChoiceProps) {
  const elements = useMemo(() => template.build(), [template]);
  return (
    <Choice
      title={template.title}
      detail={template.detail}
      disabled={disabled}
      onClick={() => onChoose({ title: template.title, elements })}
    >
      {/* @ts-expect-error BoardPreview is still JavaScript, and what is inferred for it makes `children` required. */}
      <BoardPreview elements={elements} className="aspect-[16/10]" padding={10} />
    </Choice>
  );
}

/**
 * Pick how a new board starts: blank, a built-in template, or one of the
 * person's own saved templates. `onCreate` receives what to send to
 * api.createBoard ({} for blank, { title, elements } or { templateId }).
 * Saved templates are listed as light previews; the server copies the full one when a board starts from it.
 */
type NewBoardDialogProps = {
  open: boolean;
  onClose: () => void;
  onCreate: (input: CreateBoardInput) => void;
  busy?: boolean;
};

export function NewBoardDialog({ open, onClose, onCreate, busy = false }: NewBoardDialogProps) {
  // null until the list has loaded. The `!`s below are for the type checker: no list counts as no templates.
  const [mine, setMine] = useState<TemplateSummary[] | null>(null);
  const [confirmingId, setConfirmingId] = useState<string | null>(null); // the template Delete is waiting on a second click for
  const [deletingId, setDeletingId] = useState<string | null>(null);

  useEffect(() => {
    if (!open) return undefined;
    let active = true;
    // listTemplates doesn't say what it answers with yet, so its answer is described here.
    (api.listTemplates() as Promise<{ templates: TemplateSummary[] }>)
      .then(({ templates }) => active && setMine(templates))
      .catch(() => active && setMine([]));
    return () => {
      active = false;
    };
  }, [open]);

  async function remove(template: TemplateSummary) {
    setDeletingId(template.id);
    try {
      await api.deleteTemplate(template.id);
      // Only a listed template has a Delete button, so the list is loaded by now.
      setMine((list) => list!.filter((item) => item.id !== template.id));
      toast.success(`Deleted the “${template.title}” template`);
    } catch (error) {
      toast.error((error as ApiError).message); // requests only fail with an ApiError
    } finally {
      setDeletingId(null);
      setConfirmingId(null);
    }
  }

  return (
    <Dialog
      open={open}
      onClose={onClose}
      title="Start a new board"
      description="Begin with a blank page or a ready-made layout. You can change everything afterwards."
      className="w-[min(46rem,calc(100vw-2rem))]"
    >
      <ul className="grid grid-cols-2 gap-3 sm:grid-cols-3">
        <Choice title="Blank board" detail="Start from nothing" disabled={busy} onClick={() => onCreate({})}>
          <span className="grid aspect-[16/10] place-items-center text-graphite">
            {busy ? (
              <LoaderCircle className="size-6 animate-spin" aria-hidden />
            ) : (
              <FilePlus2 className="size-7" strokeWidth={1.5} aria-hidden />
            )}
          </span>
        </Choice>
        {BUILTIN_TEMPLATES.map((template) => (
          <BuiltinChoice key={template.id} template={template} disabled={busy} onChoose={onCreate} />
        ))}
      </ul>

      {mine?.length! > 0 && (
        <>
          <h3 className="mt-6 mb-3 text-sm font-medium text-graphite">Your templates</h3>
          <ul className="grid grid-cols-2 gap-3 sm:grid-cols-3">
            {mine!.map((template) => (
              <Choice
                key={template.id}
                title={template.title}
                detail={`${template.elementCount} elements`}
                disabled={busy}
                onClick={() => onCreate({ templateId: template.id })}
                action={
                  confirmingId === template.id ? (
                    <span className="absolute top-1.5 right-1.5 flex gap-1 rounded-lg bg-surface/90 p-1 shadow-sm">
                      <Button variant="ghost" size="sm" autoFocus onClick={() => setConfirmingId(null)}>
                        Keep
                      </Button>
                      <Button
                        variant="danger"
                        size="sm"
                        loading={deletingId === template.id}
                        onClick={() => remove(template)}
                        aria-label={`Confirm deleting the ${template.title} template`}
                      >
                        Delete
                      </Button>
                    </span>
                  ) : (
                    <IconButton
                      label={`Delete the ${template.title} template`}
                      icon={Trash2}
                      size="sm"
                      onClick={() => setConfirmingId(template.id)}
                      className="absolute top-1.5 right-1.5 bg-surface/90 text-danger opacity-0 shadow-sm group-focus-within:opacity-100 group-hover:opacity-100 focus-visible:opacity-100 [@media(pointer:coarse)]:opacity-100"
                    />
                  )
                }
              >
                {/* @ts-expect-error BoardPreview is still JavaScript, and what is inferred for it makes `children` required. */}
                <BoardPreview elements={template.preview ?? []} className="aspect-[16/10]" padding={10} />
              </Choice>
            ))}
          </ul>
        </>
      )}
    </Dialog>
  );
}
