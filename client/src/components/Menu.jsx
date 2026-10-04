import clsx from "clsx";
import { createContext, useContext, useEffect, useId, useRef, useState } from "react";

const MenuContext = createContext(() => {});

/**
 * A small dropdown menu. `trigger` receives the props to spread onto the
 * button that opens it.
 */
export function Menu({ trigger, children, align = "end", side = "bottom", className }) {
  const [open, setOpen] = useState(false);
  const rootRef = useRef(null);
  const menuId = useId();

  useEffect(() => {
    if (!open) return undefined;
    const onPointerDown = (event) => {
      if (!rootRef.current?.contains(event.target)) setOpen(false);
    };
    const onKeyDown = (event) => {
      if (event.key === "Escape") setOpen(false);
    };
    document.addEventListener("pointerdown", onPointerDown);
    document.addEventListener("keydown", onKeyDown);
    // Move focus into the menu so keyboard users land on the first item.
    rootRef.current?.querySelector('[role="menuitem"]')?.focus();
    return () => {
      document.removeEventListener("pointerdown", onPointerDown);
      document.removeEventListener("keydown", onKeyDown);
    };
  }, [open]);

  const onMenuKeyDown = (event) => {
    if (event.key !== "ArrowDown" && event.key !== "ArrowUp") return;
    event.preventDefault();
    const items = [...rootRef.current.querySelectorAll('[role="menuitem"]:not(:disabled)')];
    if (items.length === 0) return;
    const index = items.indexOf(document.activeElement);
    const step = event.key === "ArrowDown" ? 1 : -1;
    const next = index === -1 ? (step === 1 ? 0 : items.length - 1) : (index + step + items.length) % items.length;
    items[next].focus();
  };

  return (
    <div ref={rootRef} className="relative">
      {trigger({
        "aria-haspopup": "menu",
        "aria-expanded": open,
        "aria-controls": menuId,
        onClick: () => setOpen((value) => !value),
      })}
      {open && (
        <div
          id={menuId}
          role="menu"
          onKeyDown={onMenuKeyDown}
          className={clsx(
            "floating-panel absolute z-50 min-w-52 rounded-xl p-1",
            align === "end" ? "right-0" : "left-0",
            side === "bottom" ? "top-full mt-2" : "bottom-full mb-2",
            className,
          )}
        >
          <MenuContext.Provider value={() => setOpen(false)}>{children}</MenuContext.Provider>
        </div>
      )}
    </div>
  );
}

export function MenuItem({ icon: Icon, children, onSelect, tone, hint, disabled }) {
  const close = useContext(MenuContext);
  return (
    <button
      type="button"
      role="menuitem"
      disabled={disabled}
      onClick={() => {
        close();
        onSelect?.();
      }}
      className={clsx(
        "flex w-full items-center gap-2.5 rounded-lg px-2.5 py-2 text-left text-sm transition-colors hover:bg-ink/6 focus-visible:bg-ink/6 focus-visible:outline-none disabled:opacity-50",
        tone === "danger" ? "text-danger" : "text-ink",
      )}
    >
      {Icon && <Icon className="size-4 shrink-0" strokeWidth={1.75} aria-hidden />}
      <span className="flex-1">{children}</span>
      {hint && <span className="text-xs text-graphite">{hint}</span>}
    </button>
  );
}

export function MenuSeparator() {
  return <div role="separator" className="my-1 h-px bg-rule" />;
}

export function MenuLabel({ children }) {
  return <div className="px-2.5 pt-2 pb-1 text-xs font-medium text-graphite">{children}</div>;
}
