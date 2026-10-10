import clsx from "clsx";
import { X } from "lucide-react";
import { useEffect, useId, useRef } from "react";
import { Button, IconButton } from "./Button";

// Built on the native <dialog>, which handles focus trapping and Escape.
export function Dialog({ open, onClose, title, description, children, className }) {
  const ref = useRef(null);
  const pressedBackdrop = useRef(false);
  const titleId = useId();
  const descriptionId = useId();

  useEffect(() => {
    const dialog = ref.current;
    if (open && !dialog.open) dialog.showModal();
    if (!open && dialog.open) dialog.close();
  }, [open]);

  return (
    <dialog
      ref={ref}
      onClose={onClose}
      // Only a click that began on the backdrop closes it, not a text selection dragged out of the dialog.
      onPointerDown={(event) => {
        pressedBackdrop.current = event.target === ref.current;
      }}
      onClick={(event) => event.target === ref.current && pressedBackdrop.current && onClose()}
      aria-labelledby={titleId}
      aria-describedby={description ? descriptionId : undefined}
      className={clsx(
        "m-auto w-[min(28rem,calc(100vw-2rem))] rounded-xl border border-rule bg-surface p-0 text-ink shadow-2xl",
        className,
      )}
    >
      {open && (
        <div className="p-6">
          <div className="flex items-start justify-between gap-4">
            <div>
              <h2 id={titleId} className="text-lg font-semibold">
                {title}
              </h2>
              {description && (
                <p id={descriptionId} className="mt-1 text-sm text-graphite">
                  {description}
                </p>
              )}
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
