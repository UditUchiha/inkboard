import clsx from "clsx";
import { createContext, useCallback, useContext, useEffect, useId, useRef, useState } from "react";

const MenuContext = createContext(() => {});

/** Closes the menu it is called inside, for items that aren't a MenuItem. */
export const useCloseMenu = () => useContext(MenuContext);

/**
 * A small dropdown menu. `trigger` receives the props to spread onto the
 * button that opens it. `onOpenChange` hears when it opens or closes.
 */
export function Menu({ trigger, children, align = "end", side = "bottom", className, onOpenChange }) {
  const [open, setOpen] = useState(false);
  const rootRef = useRef(null);
  const menuId = useId();
  const returnFocus = useRef(false);
  const isOpen = useRef(false);
  const onOpenChangeRef = useRef(onOpenChange);
  onOpenChangeRef.current = onOpenChange;

  // `restoreFocus` puts focus back on the button that opened the menu (Escape, picking an item), but
  // not when the menu closes because someone clicked elsewhere.
  const setMenuOpen = useCallback((next, restoreFocus = false) => {
    returnFocus.current = restoreFocus;
    if (isOpen.current === next) return;
    isOpen.current = next;
    setOpen(next);
    onOpenChangeRef.current?.(next);
  }, []);

  // A menu can go away while open (browser Back, or a link elsewhere on the page); it still counts as closing, so
  // whatever happens on close (marking notifications as seen, say) isn't skipped.
  useEffect(
    () => () => {
      if (!isOpen.current) return;
      isOpen.current = false;
      onOpenChangeRef.current?.(false);
    },
    [],
  );

  useEffect(() => {
    if (open || !returnFocus.current) return;
    returnFocus.current = false;
    rootRef.current?.querySelector('[aria-haspopup="menu"]')?.focus();
  }, [open]);

  useEffect(() => {
    if (!open) return undefined;
    const onPointerDown = (event) => {
      if (!rootRef.current?.contains(event.target)) setMenuOpen(false);
    };
    const onKeyDown = (event) => {
      if (event.key === "Escape") setMenuOpen(false, true);
    };
    document.addEventListener("pointerdown", onPointerDown);
    document.addEventListener("keydown", onKeyDown);
    // Move focus into the menu so keyboard users land on the first item.
    rootRef.current?.querySelector('[role="menuitem"]')?.focus();
    return () => {
      document.removeEventListener("pointerdown", onPointerDown);
      document.removeEventListener("keydown", onKeyDown);
    };
  }, [open, setMenuOpen]);

  const onMenuKeyDown = (event) => {
    if (!["ArrowDown", "ArrowUp", "Home", "End"].includes(event.key)) return;
    event.preventDefault();
    const items = [...rootRef.current.querySelectorAll('[role="menuitem"]:not(:disabled)')];
    if (items.length === 0) return;
    if (event.key === "Home") return items[0].focus();
    if (event.key === "End") return items.at(-1).focus();
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
        onClick: () => setMenuOpen(!open),
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
          <MenuContext.Provider value={() => setMenuOpen(false, true)}>{children}</MenuContext.Provider>
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
