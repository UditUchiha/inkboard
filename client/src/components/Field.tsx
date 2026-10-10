import clsx from "clsx";
import { Eye, EyeOff } from "lucide-react";
import { useId, useState } from "react";
import type { ComponentPropsWithoutRef, ReactNode } from "react";

const inputClass =
  "h-11 w-full rounded-lg border border-rule bg-surface px-3 text-[15px] text-ink transition-colors placeholder:text-graphite/70 hover:border-graphite/60 focus:border-signal focus:ring-3 focus:ring-signal/20 focus:outline-none aria-invalid:border-danger";

// An `error` takes the place of the `hint` while there is one.
type FieldProps = { label: ReactNode; hint?: ReactNode; error?: ReactNode } & ComponentPropsWithoutRef<"input">;

// `className` goes on the wrapper, not the input.
export function TextField({ label, hint, error, id, className, ...props }: FieldProps) {
  const autoId = useId();
  const inputId = id ?? autoId;
  const messageId = `${inputId}-message`;
  const message = error || hint;

  return (
    <div className={clsx("grid gap-1.5", className)}>
      <label htmlFor={inputId} className="text-sm font-medium text-ink">
        {label}
      </label>
      <input
        id={inputId}
        aria-invalid={error ? true : undefined}
        aria-describedby={message ? messageId : undefined}
        className={inputClass}
        {...props}
      />
      {message && (
        <p id={messageId} className={clsx("text-sm", error ? "text-danger" : "text-graphite")}>
          {message}
        </p>
      )}
    </div>
  );
}

export function PasswordField({ label, hint, error, id, ...props }: FieldProps) {
  const autoId = useId();
  const inputId = id ?? autoId;
  const messageId = `${inputId}-message`;
  const [visible, setVisible] = useState(false);
  const message = error || hint;

  return (
    <div className="grid gap-1.5">
      <label htmlFor={inputId} className="text-sm font-medium text-ink">
        {label}
      </label>
      <div className="relative">
        <input
          id={inputId}
          type={visible ? "text" : "password"}
          aria-invalid={error ? true : undefined}
          aria-describedby={message ? messageId : undefined}
          className={clsx(inputClass, "pr-11")}
          {...props}
        />
        <button
          type="button"
          onClick={() => setVisible((v) => !v)}
          aria-label={visible ? "Hide password" : "Show password"}
          className="absolute inset-y-0 right-0 grid w-11 place-items-center rounded-r-lg text-graphite hover:text-ink"
        >
          {visible ? <EyeOff className="size-4" aria-hidden /> : <Eye className="size-4" aria-hidden />}
        </button>
      </div>
      {message && (
        <p id={messageId} className={clsx("text-sm", error ? "text-danger" : "text-graphite")}>
          {message}
        </p>
      )}
    </div>
  );
}
