const relative = new Intl.RelativeTimeFormat(undefined, { numeric: "auto" });

const UNITS: [Intl.RelativeTimeFormatUnit, number][] = [
  ["year", 365 * 24 * 3600],
  ["month", 30 * 24 * 3600],
  ["week", 7 * 24 * 3600],
  ["day", 24 * 3600],
  ["hour", 3600],
  ["minute", 60],
];

export function timeAgo(date: string | number | Date, now = Date.now()) {
  const seconds = (new Date(date).getTime() - now) / 1000;
  for (const [unit, size] of UNITS) {
    if (Math.abs(seconds) >= size) return relative.format(Math.round(seconds / size), unit);
  }
  return "just now";
}

const graphemes = new Intl.Segmenter(undefined, { granularity: "grapheme" });
const firstLetter = (word: string): string => graphemes.segment(word)[Symbol.iterator]().next().value?.segment ?? "";

/** One or two capitals for an avatar. Emoji and accented letters stay whole instead of being cut in half. */
export function initials(name = "") {
  const parts = name.trim().split(/\s+/).filter(Boolean);
  if (parts.length === 0) return "?";
  const first = firstLetter(parts[0]);
  // `at(-1)` is a word whenever there is more than one.
  const last = parts.length > 1 ? firstLetter(parts.at(-1)!) : "";
  return (first + last).toUpperCase();
}

// Collaborator colors: distinct, readable on paper and on the blueprint theme, and dark enough for white
// text on top of them (4.5:1).
export const PEOPLE_COLORS = ["#c2410c", "#237a35", "#1971c2", "#9c36b5", "#c2255c", "#0b7285", "#946200", "#5f3dc4"];

export function colorFor(id = "") {
  let hash = 0;
  for (const char of id) hash = (hash * 31 + char.charCodeAt(0)) | 0;
  return PEOPLE_COLORS[Math.abs(hash) % PEOPLE_COLORS.length];
}

// The lighter colors people could pick before, and the darker ones that replaced them.
const LEGACY_COLORS: Record<string, string> = {
  "#e8590c": "#c2410c",
  "#2f9e44": "#237a35",
  "#0c8599": "#0b7285",
  "#f08c00": "#946200",
};

const channel = (value: number) => {
  const c = value / 255;
  return c <= 0.03928 ? c / 12.92 : ((c + 0.055) / 1.055) ** 2.4;
};
const luminance = ([r, g, b]: number[]) => 0.2126 * channel(r) + 0.7152 * channel(g) + 0.0722 * channel(b);
const toHex = (rgb: number[]) => `#${rgb.map((n) => Math.round(n).toString(16).padStart(2, "0")).join("")}`;

/** How well white text reads on `rgb` (WCAG contrast ratio, 1 to 21). */
export const contrastWithWhite = (rgb: number[]) => 1.05 / (luminance(rgb) + 0.05);

/**
 * `color` as a background white text can be read on (4.5:1): an old palette color becomes the one that replaced it,
 * and any other color too light for white text is darkened until it is, keeping its hue. Colors saved before the
 * palette changed (or set some other way) would otherwise put unreadable initials and names on screen.
 */
export function readableColor<T extends string | null | undefined>(color: T) {
  if (typeof color !== "string") return color;
  const lower = color.toLowerCase();
  if (LEGACY_COLORS[lower]) return LEGACY_COLORS[lower];
  const match = /^#([0-9a-f]{2})([0-9a-f]{2})([0-9a-f]{2})$/.exec(lower);
  if (!match) return color;
  let rgb = match.slice(1).map((part) => Number.parseInt(part, 16));
  if (contrastWithWhite(rgb) >= 4.5) return color;
  while (contrastWithWhite(rgb.map(Math.round)) < 4.5) rgb = rgb.map((n) => n * 0.95);
  return toHex(rgb);
}

/** The color someone chose in their settings (made readable), or one picked from their id. */
export const personColor = (person?: { id?: string; userId?: string; color?: string | null } | null) =>
  readableColor(person?.color) || colorFor(person?.id ?? person?.userId ?? "");
