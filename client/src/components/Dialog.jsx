import clsx from "clsx";
import { X } from "lucide-react";
import { useEffect, useRef } from "react";
import { Button, IconButton } from "./Button";

// Built on the native <dialog>, which handles focus trapping and Escape.
export function Dialog({ open, onClose, title, description, children, className }) {
  const ref = useRef(null);

  useEffect(() => {
    const dialog = ref.current;
    if (open && !dialog.open) dialog.showModal();
    if (!open && dialog.open) dialog.close();
  }, [open]);

  return (
    <dialog
      ref={ref}
      onClose={onClose}
      onClick={(event) => event.target === ref.current && onClose()}
      aria-labelledby="dialog-title"
      className={clsx(
        "m-auto w-[min(28rem,calc(100vw-2rem))] rounded-xl border border-rule bg-surface p-0 text-ink shadow-2xl",
        className,
      )}
    >
      {open && (
        <div className="p-6">
          <div className="flex items-start justify-between gap-4">
            <div>
              <h2 id="dialog-title" className="text-lg font-semibold">
                {title}
              </h2>
              {description && <p className="mt-1 text-sm text-graphite">{description}</p>}
            </div>
            <IconButton label="Close" icon={X} size="sm" onClick={onClose} className="-mt-1 -mr-2" />
          </div>
          <div className="mt-5">{children}</div>
        </div>
      )}
    </dialog>
  );
}

export function ConfirmDialog({ open, onClose, onConfirm, title, description, confirmLabel, busy, tone = "danger" }) {
  return (
    <Dialog open={open} onClose={onClose} title={title} description={description}>
      <div className="flex justify-end gap-2">
        <Button variant="secondary" onClick={onClose}>
          Cancel
        </Button>
        <Button variant={tone} loading={busy} onClick={onConfirm}>
          {confirmLabel}
        </Button>
      </div>
    </Dialog>
  );
}
