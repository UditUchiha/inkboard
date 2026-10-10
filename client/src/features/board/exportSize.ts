// How big a picture of the board can be.

const MAX_DIMENSION = 8000;
// Browsers cap a canvas by its pixel count: iOS Safari at about 16.7 million, whatever the shape.
const MAX_PIXELS = 16_000_000;
export const MIN_SCALE = 0.05; // below this a picture of the board would show nothing useful

/** A problem with an export that can be shown to the person as it is. */
export class ExportError extends Error {}

/** How much to scale a board of `width` x `height` units: twice for sharpness, less to stay inside what a canvas can be. */
export function exportScale(width: number, height: number): number {
  return Math.min(2, MAX_DIMENSION / width, MAX_DIMENSION / height, Math.sqrt(MAX_PIXELS / (width * height)));
}
