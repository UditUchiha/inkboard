import clsx from "clsx";
import { Ban, CopyPlus, Trash2 } from "lucide-react";
import { FILL_COLORS, FONT_SIZES, FONTS, PEN_SIZES, STROKE_COLORS, STROKE_WIDTHS, STYLE_CONTROLS } from "./constants";

function Section({ label, children }) {
  return (
    <fieldset className="grid gap-2">
      <legend className="mb-2 text-xs font-medium text-graphite">{label}</legend>
      {children}
    </fieldset>
  );
}

function Swatch({ color, name, selected, onClick, children }) {
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

function CustomColor({ value, onChange, label }) {
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

function Segmented({ options, value, onChange, renderLabel = (option) => option.name }) {
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

const isPreset = (palette, value) => palette.some((item) => item.value === value);

/**
 * Shows the style options for the active drawing tool, or for the selected
 * element when the select tool is active.
 */
export function PropertiesPanel({ type, values, onChange, selection, onDuplicate, onDelete }) {
  const controls = STYLE_CONTROLS[type] ?? [];

  return (
    <aside
      aria-label={selection ? "Selected element" : "Tool style"}
      className="floating-panel grid max-h-[calc(100dvh-10rem)] w-60 gap-5 overflow-y-auto rounded-xl p-4"
    >
      {controls.includes("stroke") && (
        <Section label={type === "text" ? "Color" : "Stroke"}>
          <div className="flex flex-wrap gap-1.5">
            {STROKE_COLORS.map((color) => (
              <Swatch
                key={color.value}
                color={color.value}
                name={color.name}
                selected={values.stroke === color.value}
                onClick={() => onChange("stroke", color.value)}
              />
            ))}
            <CustomColor
              label="Custom stroke color"
              value={values.stroke}
              onChange={(value) => onChange("stroke", value)}
            />
          </div>
          {!isPreset(STROKE_COLORS, values.stroke) && <p className="text-xs text-graphite">Custom: {values.stroke}</p>}
        </Section>
      )}

      {controls.includes("fill") && (
        <Section label="Fill">
          <div className="flex flex-wrap gap-1.5">
            <Swatch name="No fill" selected={!values.fill} onClick={() => onChange("fill", null)}>
              <Ban className="size-3.5 text-graphite" strokeWidth={1.75} aria-hidden />
            </Swatch>
            {FILL_COLORS.map((color) => (
              <Swatch
                key={color.value}
                color={color.value}
                name={color.name}
                selected={values.fill === color.value}
                onClick={() => onChange("fill", color.value)}
              />
            ))}
            <CustomColor label="Custom fill color" value={values.fill} onChange={(value) => onChange("fill", value)} />
          </div>
        </Section>
      )}

      {controls.includes("strokeWidth") && (
        <Section label="Stroke width">
          <Segmented
            options={STROKE_WIDTHS}
            value={values.strokeWidth}
            onChange={(value) => onChange("strokeWidth", value)}
            renderLabel={(option) => (
              <span className="block w-6 rounded-full bg-current" style={{ height: Math.max(1.5, option.value) }} />
            )}
          />
        </Section>
      )}

      {controls.includes("penSize") && (
        <Section label="Pen size">
          <Segmented
            options={PEN_SIZES}
            value={values.penSize}
            onChange={(value) => onChange("penSize", value)}
            renderLabel={(option) => (
              <span
                className="block rounded-full bg-current"
                style={{ width: option.value * 0.7 + 3, height: option.value * 0.7 + 3 }}
              />
            )}
          />
        </Section>
      )}

      {controls.includes("sketchy") && (
        <Section label="Edges">
          <Segmented
            options={[
              { name: "Hand-drawn", value: true },
              { name: "Clean", value: false },
            ]}
            value={values.sketchy}
            onChange={(value) => onChange("sketchy", value)}
          />
        </Section>
      )}

      {controls.includes("font") && (
        <Section label="Font">
          <Segmented
            options={Object.entries(FONTS).map(([value, font]) => ({ name: font.name, value }))}
            value={values.font}
            onChange={(value) => onChange("font", value)}
            renderLabel={(option) => (
              <span
                style={{ fontFamily: FONTS[option.value].family }}
                className={option.value === "hand" ? "text-base" : ""}
              >
                {option.name}
              </span>
            )}
          />
        </Section>
      )}

      {controls.includes("fontSize") && (
        <Section label="Size">
          <Segmented options={FONT_SIZES} value={values.fontSize} onChange={(value) => onChange("fontSize", value)} />
        </Section>
      )}

      {selection && (
        <div className={clsx("flex gap-2", controls.length > 0 && "border-t border-rule pt-4")}>
          <button
            type="button"
            onClick={onDuplicate}
            className="flex h-8 flex-1 items-center justify-center gap-1.5 rounded-lg border border-rule text-xs font-medium hover:bg-surface-2"
          >
            <CopyPlus className="size-3.5" aria-hidden /> Duplicate
          </button>
          <button
            type="button"
            onClick={onDelete}
            className="flex h-8 flex-1 items-center justify-center gap-1.5 rounded-lg border border-rule text-xs font-medium text-danger hover:bg-surface-2"
          >
            <Trash2 className="size-3.5" aria-hidden /> Delete
          </button>
        </div>
      )}
    </aside>
  );
}
