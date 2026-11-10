const MAX_DIMENSION = 8000;
// Browsers cap a canvas by its pixel count: iOS Safari at about 16.7 million, whatever the shape.
const MAX_PIXELS = 16_000_000;
export const MIN_SCALE = 0.05; // below this a picture of the board would show nothing useful

export class ExportError extends Error {}

export function exportScale(width: number, height: number): number {
  return Math.min(2, MAX_DIMENSION / width, MAX_DIMENSION / height, Math.sqrt(MAX_PIXELS / (width * height)));
}
