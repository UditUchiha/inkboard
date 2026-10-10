import clsx from "clsx";
import { LoaderCircle } from "lucide-react";
import type { LucideIcon } from "lucide-react";
import type { ComponentPropsWithoutRef } from "react";
import { Link } from "react-router";

const VARIANTS = {
  primary: "bg-ink text-on-ink hover:bg-ink-soft",
  secondary: "border border-rule bg-surface text-ink hover:bg-surface-2",
  ghost: "text-ink hover:bg-ink/6",
  danger: "bg-danger-solid text-white hover:bg-danger-solid-hover",
};

const SIZES = {
  sm: "h-8 gap-1.5 px-3 text-sm",
  md: "h-10 gap-2 px-4 text-[15px]",
  lg: "h-12 gap-2 px-6 text-base",
};

/** How a button looks, whatever it is made of. */
export type ButtonVariant = keyof typeof VARIANTS;
type ButtonSize = keyof typeof SIZES;
type ButtonStyle = { variant?: ButtonVariant; size?: ButtonSize; className?: string };

export const buttonClass = ({ variant = "primary", size = "md", className }: ButtonStyle = {}) =>
  clsx(
    "inline-flex shrink-0 items-center justify-center rounded-lg font-medium whitespace-nowrap transition-colors disabled:opacity-55",
    VARIANTS[variant],
    SIZES[size],
    className,
  );

type ButtonLinkProps = ButtonStyle & { icon?: LucideIcon } & ComponentPropsWithoutRef<typeof Link>;

export function ButtonLink({ variant, size, icon: Icon, className, children, ...props }: ButtonLinkProps) {
  return (
    <Link className={buttonClass({ variant, size, className })} {...props}>
      {Icon && <Icon className="size-4" aria-hidden />}
      {children}
    </Link>
  );
}

type ButtonProps = ButtonStyle & { loading?: boolean; icon?: LucideIcon } & ComponentPropsWithoutRef<"button">;

export function Button({
  variant = "primary",
  size = "md",
  loading = false,
  icon: Icon,
  className,
  children,
  type = "button",
  disabled,
  ...props
}: ButtonProps) {
  return (
    <button type={type} disabled={disabled || loading} className={buttonClass({ variant, size, className })} {...props}>
      {loading ? (
        <LoaderCircle className="size-4 animate-spin" aria-hidden />
      ) : (
        Icon && <Icon className="size-4" aria-hidden />
      )}
      {children}
    </button>
  );
}

type IconButtonProps = {
  label: string;
  icon: LucideIcon;
  active?: boolean;
  size?: "sm" | "md";
} & ComponentPropsWithoutRef<"button">;

export function IconButton({ label, icon: Icon, active = false, className, size = "md", ...props }: IconButtonProps) {
  return (
    <button
      type="button"
      aria-label={label}
      title={label}
      className={clsx(
        "grid shrink-0 place-items-center rounded-lg text-ink transition-colors disabled:opacity-35",
        size === "sm" ? "size-8" : "size-10",
        active ? "bg-marker text-[#16213a]" : "hover:bg-ink/6",
        className,
      )}
      {...props}
    >
      <Icon className={size === "sm" ? "size-4" : "size-[18px]"} strokeWidth={1.75} aria-hidden />
    </button>
  );
}
