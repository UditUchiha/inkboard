import { MAX_ALT_LENGTH } from "@inkboard/shared/element-rules";
import type { ElementType, Font, ImageCrop, StackMove } from "@inkboard/shared/types";
import clsx from "clsx";
import { ArrowDown, ArrowDownToLine, ArrowUp, ArrowUpToLine, Ban, CopyPlus, Crop, Trash2 } from "lucide-react";
import type { LucideIcon } from "lucide-react";
import type { ReactNode } from "react";
import {
  FILL_COLORS,
  FONT_SIZES,
  FONTS,
  NOTE_COLORS,
  PEN_SIZES,
  ROUTE_OPTIONS,
  STROKE_COLORS,
  STROKE_WIDTHS,
  STYLE_CONTROLS,
} from "../constants/board";
import type { Style } from "../constants/board";
import { mathSource } from "../lib/elements/math";
import { isComposing } from "../lib/mentions";
import { CustomColor, isPreset, Section, Segmented, Swatch } from "./PanelControls";

const STACK_BUTTONS: { where: StackMove; label: string; icon: LucideIcon }[] = [
  { where: "back", label: "Send to back", icon: ArrowDownToLine },
  { where: "backward", label: "Send backward", icon: ArrowDown },
  { where: "forward", label: "Bring forward", icon: ArrowUp },
  { where: "front", label: "Bring to front", icon: ArrowUpToLine },
];

type Settings = Pick<
  Style,
  "stroke" | "fill" | "strokeWidth" | "penSize" | "sketchy" | "route" | "startHead" | "font" | "fontSize"
> & { name: string; alt: string };

export type StyleChange = { [K in keyof Settings]: [key: K, value: Settings[K]] }[keyof Settings];

export type PanelValues = Partial<Settings> & {
  // An arrow or line without text has no label to set a font for.
  text?: string;
  type?: ElementType;
  crop?: ImageCrop;
};

export type PropertiesPanelProps = {
  type: ElementType;
  values: PanelValues;
  onChange: (...change: StyleChange) => void;
  selection: boolean;
  onDuplicate: () => void;
  onDelete: () => void;
  stackMoves?: Partial<Record<StackMove, boolean>>;
  onMove: (where: StackMove) => void;
  cropping?: boolean;
  onToggleCrop?: () => void;
  onUncrop?: () => void;
  children?: ReactNode;
};

export function PropertiesPanel({
  type,
  values,
  onChange,
  selection,
  onDuplicate,
  onDelete,
  stackMoves = {},
  onMove,
  children,
  cropping = false,
  onToggleCrop,
  onUncrop,
}: PropertiesPanelProps) {
  const controls = STYLE_CONTROLS[type] ?? [];

  return (
    <aside
      aria-label={selection ? "Selected element" : "Tool style"}
      className="floating-panel grid max-h-[calc(100dvh-10rem)] w-60 gap-5 overflow-y-auto rounded-xl p-4"
    >
      {controls.includes("name") && (
        <label className="grid gap-2">
          <span className="text-xs font-medium text-graphite">Name</span>
          <input
            value={values.name ?? ""}
            onChange={(event) => onChange("name", event.target.value.slice(0, 200))}
            // Enter while an input method is composing confirms the text, not the name.
            onKeyDown={(event) => event.key === "Enter" && !isComposing(event) && event.currentTarget.blur()}
            placeholder="Frame"
            className="h-8 rounded-lg border border-rule bg-surface px-2 text-sm outline-none focus:border-signal"
          />
        </label>
      )}

      {controls.includes("crop") && selection && (
        <Section label="Crop">
          <div className="flex gap-2">
            <button
              type="button"
              aria-pressed={cropping}
              onClick={onToggleCrop}
              className={clsx(
                "flex h-8 flex-1 items-center justify-center gap-1.5 rounded-lg border text-xs font-medium",
                cropping ? "border-signal bg-signal/10 text-ink" : "border-rule hover:bg-surface-2",
              )}
            >
              <Crop className="size-3.5" aria-hidden /> {cropping ? "Done" : "Crop"}
            </button>
            {values.crop && (
              <button
                type="button"
                onClick={onUncrop}
                className="h-8 flex-1 rounded-lg border border-rule text-xs font-medium hover:bg-surface-2"
              >
                Show all
              </button>
            )}
          </div>
          {cropping && (
            <p className="text-xs text-graphite">Drag the handles to choose what shows. Press Esc when you're done.</p>
          )}
        </Section>
      )}

      {controls.includes("alt") && selection && (
        <label className="grid gap-2">
          <span className="text-xs font-medium text-graphite">Alt text</span>
          <textarea
            value={values.alt ?? ""}
            onChange={(event) => onChange("alt", event.target.value.slice(0, MAX_ALT_LENGTH))}
            placeholder="Describe the picture for people who can't see it"
            rows={3}
            className="resize-none rounded-lg border border-rule bg-surface px-2 py-1.5 text-sm outline-none focus:border-signal"
          />
        </label>
      )}

      {controls.includes("noteFill") && (
        <Section label="Color">
          <div className="flex flex-wrap gap-1.5">
            {NOTE_COLORS.map((color) => (
              <Swatch
                key={color.value}
                color={color.value}
                name={color.name}
                selected={values.fill === color.value}
                onClick={() => onChange("fill", color.value)}
              />
            ))}
            <CustomColor label="Custom note color" value={values.fill} onChange={(value) => onChange("fill", value)} />
          </div>
        </Section>
      )}

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

      {controls.includes("route") && (
        <Section label="Path">
          <Segmented
            options={ROUTE_OPTIONS}
            value={values.route ?? "straight"}
            onChange={(value) => onChange("route", value)}
          />
        </Section>
      )}

      {controls.includes("startHead") && (
        <Section label="Arrowheads">
          <Segmented
            options={[
              { name: "End", value: false },
              { name: "Both ends", value: true },
            ]}
            value={Boolean(values.startHead)}
            onChange={(value) => onChange("startHead", value)}
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

      {/* An equation is typeset in its own font. */}
      {((controls.includes("font") && mathSource(values.text ?? "") === null) ||
        (controls.includes("labelFont") && values.text)) && (
        <Section label={controls.includes("labelFont") ? "Label font" : "Font"}>
          <Segmented
            // Object.entries gives the keys of FONTS as strings, and they are its fonts.
            options={Object.entries(FONTS).map(([value, font]) => ({ name: font.name, value: value as Font }))}
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
        <div className={clsx("grid gap-4", controls.length > 0 && "border-t border-rule pt-4")}>
          <Section label="Layer">
            <div className="grid grid-cols-4 gap-1 rounded-lg bg-ink/5 p-0.5">
              {STACK_BUTTONS.map(({ where, label, icon: Icon }) => (
                <button
                  key={where}
                  type="button"
                  title={label}
                  aria-label={label}
                  disabled={!stackMoves[where]}
                  onClick={() => onMove(where)}
                  className="grid h-8 place-items-center rounded-md text-graphite transition-colors enabled:hover:bg-surface enabled:hover:text-ink disabled:opacity-35"
                >
                  <Icon className="size-4" strokeWidth={1.75} aria-hidden />
                </button>
              ))}
            </div>
          </Section>
          <div className="flex gap-2">
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
          {children}
        </div>
      )}
    </aside>
  );
}
