import clsx from "clsx";
import { FilePlus2, LoaderCircle, Trash2 } from "lucide-react";
import { useEffect, useMemo, useState } from "react";
import { toast } from "sonner";
import { IconButton } from "../../components/Button";
import { Dialog } from "../../components/Dialog";
import { api } from "../../lib/api";
import { BoardPreview } from "../board/BoardPreview";
import { BUILTIN_TEMPLATES } from "./builtin";

function Choice({ title, detail, disabled, onClick, children, action }) {
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

function BuiltinChoice({ template, disabled, onChoose }) {
  const elements = useMemo(() => template.build(), [template]);
  return (
    <Choice
      title={template.title}
      detail={template.detail}
      disabled={disabled}
      onClick={() => onChoose({ title: template.title, elements })}
    >
      <BoardPreview elements={elements} className="aspect-[16/10]" padding={10} />
    </Choice>
  );
}

/**
 * Pick how a new board starts: blank, a built-in template, or one of the
 * person's own saved templates. `onCreate` receives what to send to
 * api.createBoard ({} for blank, { title, elements } or { templateId }).
 */
export function NewBoardDialog({ open, onClose, onCreate, busy = false, signedIn = true }) {
  const [mine, setMine] = useState(null);

  useEffect(() => {
    if (!open || !signedIn) return undefined;
    let active = true;
    api
      .listTemplates()
      .then(({ templates }) => active && setMine(templates))
      .catch(() => active && setMine([]));
    return () => {
      active = false;
    };
  }, [open, signedIn]);

  async function remove(template) {
    try {
      await api.deleteTemplate(template.id);
      setMine((list) => list.filter((item) => item.id !== template.id));
      toast.success(`Deleted the “${template.title}” template`);
    } catch (error) {
      toast.error(error.message);
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

      {signedIn && mine?.length > 0 && (
        <>
          <h3 className="mt-6 mb-3 text-sm font-medium text-graphite">Your templates</h3>
          <ul className="grid grid-cols-2 gap-3 sm:grid-cols-3">
            {mine.map((template) => (
              <Choice
                key={template.id}
                title={template.title}
                detail={`${template.elements.length} elements`}
                disabled={busy}
                onClick={() => onCreate({ templateId: template.id })}
                action={
                  <IconButton
                    label={`Delete the ${template.title} template`}
                    icon={Trash2}
                    size="sm"
                    onClick={() => remove(template)}
                    className="absolute top-1.5 right-1.5 bg-surface/90 text-danger opacity-0 shadow-sm group-focus-within:opacity-100 group-hover:opacity-100"
                  />
                }
              >
                <BoardPreview elements={template.elements} className="aspect-[16/10]" padding={10} />
              </Choice>
            ))}
          </ul>
        </>
      )}
    </Dialog>
  );
}
