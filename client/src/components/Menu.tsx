import clsx from "clsx";
import type { LucideIcon } from "lucide-react";
import { createContext, useCallback, useContext, useEffect, useId, useRef, useState } from "react";
import type { KeyboardEvent, ReactNode } from "react";

const MenuContext = createContext<() => void>(() => {});

/** Closes the menu it is called inside, for items that aren't a MenuItem. */
export const useCloseMenu = () => useContext(MenuContext);

/** What `trigger` spreads onto the button that opens the menu. */
export type MenuTriggerProps = {
  "aria-haspopup": "menu";
  "aria-expanded": boolean;
  "aria-controls": string;
  onClick: () => void;
};

type MenuProps = {
  trigger: (props: MenuTriggerProps) => ReactNode;
  children?: ReactNode;
  align?: "start" | "end";
  side?: "top" | "bottom";
  className?: string;
  onOpenChange?: (open: boolean) => void;
};

/**
 * A small dropdown menu. `trigger` receives the props to spread onto the
 * button that opens it. `onOpenChange` hears when it opens or closes.
 */
export function Menu({ trigger, children, align = "end", side = "bottom", className, onOpenChange }: MenuProps) {
  const [open, setOpen] = useState(false);
  const rootRef = useRef<HTMLDivElement>(null);
  const menuId = useId();
  const returnFocus = useRef(false);
  const isOpen = useRef(false);
  const onOpenChangeRef = useRef(onOpenChange);
  onOpenChangeRef.current = onOpenChange;

  // `restoreFocus` puts focus back on the button that opened the menu (Escape, picking an item), but
  // not when the menu closes because someone clicked elsewhere.
  const setMenuOpen = useCallback((next: boolean, restoreFocus = false) => {
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
    rootRef.current?.querySelector<HTMLElement>('[aria-haspopup="menu"]')?.focus();
  }, [open]);

  useEffect(() => {
    if (!open) return undefined;
    const onPointerDown = (event: PointerEvent) => {
      // A pointer event on the document is aimed at a node.
      if (!rootRef.current?.contains(event.target as Node)) setMenuOpen(false);
    };
    const onKeyDown = (event: globalThis.KeyboardEvent) => {
      if (event.key === "Escape") setMenuOpen(false, true);
    };
    document.addEventListener("pointerdown", onPointerDown);
    document.addEventListener("keydown", onKeyDown);
    // Move focus into the menu so keyboard users land on the first item.
    rootRef.current?.querySelector<HTMLElement>('[role="menuitem"]')?.focus();
    return () => {
      document.removeEventListener("pointerdown", onPointerDown);
      document.removeEventListener("keydown", onKeyDown);
    };
  }, [open, setMenuOpen]);

  const onMenuKeyDown = (event: KeyboardEvent<HTMLDivElement>) => {
    if (!["ArrowDown", "ArrowUp", "Home", "End"].includes(event.key)) return;
    event.preventDefault();
    // The menu's own key handler only runs while it is drawn, inside the root.
    const items = [...rootRef.current!.querySelectorAll<HTMLElement>('[role="menuitem"]:not(:disabled)')];
    if (items.length === 0) return;
    if (event.key === "Home") return items[0].focus();
    if (event.key === "End") return items.at(-1)!.focus(); // there is at least one item
    // The focused element is only looked for among the items, so it need not be one.
    const index = items.indexOf(document.activeElement as HTMLElement);
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

type MenuItemProps = {
  icon?: LucideIcon;
  children?: ReactNode;
  onSelect?: () => void;
  tone?: "danger";
  hint?: ReactNode;
  disabled?: boolean;
};

export function MenuItem({ icon: Icon, children, onSelect, tone, hint, disabled }: MenuItemProps) {
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

export function MenuLabel({ children }: { children?: ReactNode }) {
  return <div className="px-2.5 pt-2 pb-1 text-xs font-medium text-graphite">{children}</div>;
}
