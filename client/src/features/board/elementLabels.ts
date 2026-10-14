import type { ElementType } from "@inkboard/shared/types";
import type { AnyElement } from "./elements";

// Names for board elements that a screen reader or a keyboard-driven list can show.

const TYPE_NAMES: Record<ElementType, string> = {
  pen: "Drawing",
  line: "Line",
  arrow: "Arrow",
  rectangle: "Rectangle",
  ellipse: "Ellipse",
  text: "Text",
  sticky: "Sticky note",
  frame: "Frame",
  image: "Picture",
};

const MAX_TEXT = 60;

/**
 * "Sticky note: Buy milk", "Rectangle", "Frame: Sprint 4", "Picture: A cat asleep" (from its alt text). Given a way
 * to `find` elements, a line or arrow also says what it joins: "Arrow: yes, from Rectangle: Start to Ellipse".
 */
export function describeElement(element: AnyElement, find?: (id: string) => AnyElement | undefined): string {
  const name = TYPE_NAMES[element.type] ?? "Element";
  const raw = element.type === "frame" ? element.name : element.type === "image" ? element.alt : element.text;
  const text = typeof raw === "string" ? raw.replace(/\s+/g, " ").trim() : "";
  const label = text ? `${name}: ${text.length > MAX_TEXT ? `${text.slice(0, MAX_TEXT - 1)}…` : text}` : name;
  const end = (id: unknown) => (typeof id === "string" && find?.(id)) || undefined;
  const [from, to] = "startId" in element ? [end(element.startId), end(element.endId)] : [];
  if (!from && !to) return label;
  const joins = [from && `from ${describeElement(from)}`, to && `to ${describeElement(to)}`].filter(Boolean).join(" ");
  return `${label}${text ? "," : ""} ${joins}`;
}
