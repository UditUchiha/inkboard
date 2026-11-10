// Drawings are stored in their light-mode colors. In dark mode ink becomes
// chalk: each color goes through invert(93%) then hue-rotate(180deg), so dark
// ink turns light while hues stay recognisable. The same filter is applied by
// CSS (`.canvas-ink`) to things drawn outside the canvas, like color swatches
// and the text being edited; the canvas converts its own colors instead, so
// pictures on it can be drawn untouched.
//
// The maths is the CSS filter's, from the Filter Effects spec, so both match.

const INVERT = 0.93;
const HUE_TURN = Math.PI; // 180 degrees

function hueRotateMatrix(angle: number): number[][] {
  const cos = Math.cos(angle);
  const sin = Math.sin(angle);
  return [
    [0.213 + cos * 0.787 - sin * 0.213, 0.715 - cos * 0.715 - sin * 0.715, 0.072 - cos * 0.072 + sin * 0.928],
    [0.213 - cos * 0.213 + sin * 0.143, 0.715 + cos * 0.285 + sin * 0.14, 0.072 - cos * 0.072 - sin * 0.283],
    [0.213 - cos * 0.213 - sin * 0.787, 0.715 - cos * 0.715 + sin * 0.715, 0.072 + cos * 0.928 + sin * 0.072],
  ];
}

const HUE = hueRotateMatrix(HUE_TURN);
const clamp01 = (value: number) => Math.min(1, Math.max(0, value));

/** `[r, g, b]` (0-255) as dark mode shows it. */
export function darkRgb([r, g, b]: number[]): number[] {
  const inverted = [r, g, b].map((channel) => clamp01(INVERT + (channel / 255) * (1 - 2 * INVERT)));
  return HUE.map((row) =>
    Math.round(clamp01(row[0] * inverted[0] + row[1] * inverted[1] + row[2] * inverted[2]) * 255),
  );
}

// "#rgb", "#rrggbb", "#rrggbbaa", "rgb(...)" or "rgba(...)" as [r, g, b, alpha], or null.
function parseColor(color: string): [r: number, g: number, b: number, alpha: number] | null {
  const hex = /^#([0-9a-f]{3}|[0-9a-f]{6}|[0-9a-f]{8})$/i.exec(color);
  if (hex) {
    const digits = hex[1].length === 3 ? [...hex[1]].map((digit) => digit + digit).join("") : hex[1];
    // The non-null assertion: the digits are pairs, so they match.
    const channels = digits.match(/../g)!.map((pair) => parseInt(pair, 16));
    return [channels[0], channels[1], channels[2], channels.length === 4 ? channels[3] / 255 : 1];
  }
  const rgb = /^rgba?\(\s*([\d.]+)[\s,]+([\d.]+)[\s,]+([\d.]+)(?:[\s,/]+([\d.]+))?\s*\)$/i.exec(color);
  if (rgb) return [Number(rgb[1]), Number(rgb[2]), Number(rgb[3]), rgb[4] === undefined ? 1 : Number(rgb[4])];
  return null;
}

// Colors already converted. Anyone can put any color on a board, so this starts over when it's full.
const MAX_CONVERTED = 500;
const converted = new Map<string, string>();

/** A color as dark mode shows it. Anything it can't read (like "transparent") is returned as it is. */
export function darkInk<T>(color: T): T | string {
  if (typeof color !== "string") return color;
  let result = converted.get(color);
  if (result === undefined) {
    const parsed = parseColor(color.trim());
    if (!parsed) {
      result = color;
    } else {
      const [r, g, b] = darkRgb(parsed);
      result = parsed[3] === 1 ? `rgb(${r}, ${g}, ${b})` : `rgba(${r}, ${g}, ${b}, ${parsed[3]})`;
    }
    if (converted.size >= MAX_CONVERTED) converted.clear();
    converted.set(color, result);
  }
  return result;
}
