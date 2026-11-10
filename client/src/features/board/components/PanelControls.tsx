import clsx from "clsx";
import type { ReactNode } from "react";
import type { Choice } from "../constants/board";

export function Section({ label, children }: { label: string; children: ReactNode }) {
  return (
    <fieldset className="grid gap-2">
      <legend className="mb-2 text-xs font-medium text-graphite">{label}</legend>
      {children}
    </fieldset>
  );
}

type SwatchProps = {
  color?: string;
  name: string;
  selected: boolean;
  onClick: () => void;
  children?: ReactNode;
};

export function Swatch({ color, name, selected, onClick, children }: SwatchProps) {
  return (
    <button
      type="button"
      onClick={onClick}
      aria-label={name}
      aria-pressed={selected}
      title={name}
      className={clsx(
        "canvas-ink relative grid size-6 place-items-center rounded-md border transition-transform hover:scale-110",
        selected ? "border-transparent ring-2 ring-signal ring-offset-2 ring-offset-surface" : "border-ink/15",
      )}
      style={color ? { backgroundColor: color } : undefined}
    >
      {children}
    </button>
  );
}

export function CustomColor({
  value,
  onChange,
  label,
}: {
  value?: string | null;
  onChange: (value: string) => void;
  label: string;
}) {
  return (
    <label
      title={label}
      className="canvas-ink relative grid size-6 cursor-pointer place-items-center overflow-hidden rounded-md border border-ink/15 bg-[conic-gradient(#e03131,#f08c00,#ffd84d,#2f9e44,#1971c2,#7048e8,#e03131)] transition-transform hover:scale-110"
    >
      <span className="sr-only">{label}</span>
      <input
        type="color"
        value={value ?? "#16213a"}
        onChange={(event) => onChange(event.target.value)}
        className="absolute inset-0 cursor-pointer opacity-0"
      />
    </label>
  );
}

type SegmentedProps<T> = {
  options: Choice<T>[];
  value: T | undefined;
  onChange: (value: T) => void;
  renderLabel?: (option: Choice<T>) => ReactNode;
};

export function Segmented<T>({ options, value, onChange, renderLabel = (option) => option.name }: SegmentedProps<T>) {
  return (
    <div className="grid auto-cols-fr grid-flow-col gap-1 rounded-lg bg-ink/5 p-0.5">
      {options.map((option) => (
        <button
          key={option.name}
          type="button"
          aria-pressed={value === option.value}
          title={option.name}
          onClick={() => onChange(option.value)}
          className={clsx(
            "grid h-8 place-items-center rounded-md px-1.5 text-xs font-medium transition-colors",
            value === option.value ? "bg-surface text-ink shadow-sm" : "text-graphite hover:text-ink",
          )}
        >
          {renderLabel(option)}
        </button>
      ))}
    </div>
  );
}

export const isPreset = (palette: Choice[], value: string | undefined) => palette.some((item) => item.value === value);
