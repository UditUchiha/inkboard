import type { Element as BoardElement } from "@inkboard/shared/types";
import { BOARD_FILE_EXTENSION, makeBoardFile } from "./boardFile";
import { getSceneBounds } from "./elements";
import { downloadBlob, pictureDataUrls, safeFileName } from "./files";
import { ExportError, MIN_SCALE, exportScale } from "./exportSize";
import { loadImagesOf, releaseImages } from "./images";
import { loadFormulas } from "./math";
import { elementsToMermaid } from "./mermaid";
import { loadCanvasFonts, renderScene } from "./renderer";
import { buildSvg, fontsUsed } from "./svgExport";
import { fontFacesFor, measureBaselines } from "./svgFonts";

// Exporting a board: as a picture (PNG), as vectors (SVG), as a board file
// (JSON) that can be imported again, or its diagram as Mermaid. Each resolves to false when the board is empty.

export async function exportBoardAsPng(elements: BoardElement[], fileName: string): Promise<boolean> {
  if (!getSceneBounds(elements)) return false;
  await Promise.all([loadCanvasFonts(), loadImagesOf(elements), loadFormulas(elements)]);
  // Measured once fonts have loaded and equations are typeset. The assertion: the board isn't empty.
  const bounds = getSceneBounds(elements)!;

  const padding = 32;
  const width = bounds.width + padding * 2;
  const height = bounds.height + padding * 2;
  const scale = exportScale(width, height);
  if (scale < MIN_SCALE)
    throw new ExportError("This board is too large to export as a picture. Export it as SVG instead.");

  const canvas = document.createElement("canvas");
  canvas.width = Math.ceil(width * scale);
  canvas.height = Math.ceil(height * scale);
  renderScene(canvas, {
    elements,
    viewport: { x: padding - bounds.x, y: padding - bounds.y, zoom: 1 },
    dpr: scale,
    background: "#ffffff",
  });

  const blob = await new Promise<Blob | null>((resolve) => canvas.toBlob(resolve, "image/png"));
  // Never on the page, so nothing else would let go of it (up to 64 MB of pixels).
  releaseImages(canvas);
  // A browser that can't make a canvas this big hands back nothing.
  if (!blob) throw new ExportError("The picture is too big for this browser to make. Export it as SVG instead.");
  downloadBlob(blob, `${safeFileName(fileName)}.png`);
  return true;
}

export async function exportBoardAsSvg(elements: BoardElement[], fileName: string): Promise<boolean> {
  if (!getSceneBounds(elements)) return false;
  await Promise.all([loadCanvasFonts(), loadFormulas(elements)]);
  const fonts = fontsUsed(elements);
  const [fontFaces, images] = await Promise.all([fontFacesFor(fonts), pictureDataUrls(elements)]);
  // The assertion: buildSvg gives null only for a board with nothing to draw, which is checked above.
  const svg = buildSvg(elements, { images, fontFaces, baselines: measureBaselines(fonts) })!;
  downloadBlob(new Blob([svg], { type: "image/svg+xml" }), `${safeFileName(fileName)}.svg`);
  return true;
}

export async function exportBoardAsJson(elements: BoardElement[], title: string): Promise<boolean> {
  if (elements.length === 0) return false;
  const file = makeBoardFile({ title, elements, pictures: await pictureDataUrls(elements) });
  downloadBlob(
    new Blob([JSON.stringify(file)], { type: "application/json" }),
    `${safeFileName(title)}${BOARD_FILE_EXTENSION}`,
  );
  return true;
}

/**
 * Downloads the board's diagram as a Mermaid flowchart or sequence diagram (see mermaid.ts). Throws an ExportError
 * when it has none.
 */
export async function exportBoardAsMermaid(elements: BoardElement[], title: string): Promise<boolean> {
  if (elements.length === 0) return false;
  const text = elementsToMermaid(elements);
  if (!text) throw new ExportError("There's no diagram to export: Mermaid needs shapes or sticky notes.");
  downloadBlob(new Blob([text], { type: "text/plain" }), `${safeFileName(title)}.mmd`);
  return true;
}
