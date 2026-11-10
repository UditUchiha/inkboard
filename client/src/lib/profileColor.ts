import { PEOPLE_COLORS, readableColor } from "./format";

// Only replaced palette colors move to their replacement; any other stays as is: `readableColor` darkens light custom colors for display,
// and saving that value (even with only the name changed) would replace the one the person chose.
export function formColor(color: string | null | undefined) {
  const shown = readableColor(color);
  // `readableColor` only ever changes a string, so a shown color that differs from `color` is one.
  return shown !== color && PEOPLE_COLORS.includes(shown!) ? shown : color;
}
