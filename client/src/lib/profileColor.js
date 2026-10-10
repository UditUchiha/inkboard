import { PEOPLE_COLORS, readableColor } from "./format";

/**
 * The colour the profile form starts on. Of the colours people could pick before the palette changed, only
 * the ones that were replaced move to their replacement (so they show as chosen, ready to save). Any
 * other colour stays exactly as it is: `readableColor` also darkens a light custom colour for display, but
 * that is a value nobody chose, and saving it (even with only the name changed) would replace theirs.
 */
export function formColor(color) {
  const shown = readableColor(color);
  return shown !== color && PEOPLE_COLORS.includes(shown) ? shown : color;
}
