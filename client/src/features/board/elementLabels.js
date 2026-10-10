// Names for board elements that a screen reader or a keyboard-driven list can show.

const TYPE_NAMES = {
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

/** "Sticky note: Buy milk", "Rectangle", "Frame: Sprint 4". */
export function describeElement(element) {
  const name = TYPE_NAMES[element.type] ?? "Element";
  const raw = element.type === "frame" ? element.name : element.text;
  const text = typeof raw === "string" ? raw.replace(/\s+/g, " ").trim() : "";
  if (!text) return name;
  return `${name}: ${text.length > MAX_TEXT ? `${text.slice(0, MAX_TEXT - 1)}…` : text}`;
}
