import { BOARD_FILE_EXTENSION, makeBoardFile } from "./boardFile";
import { getSceneBounds } from "./elements";
import { downloadBlob, pictureDataUrls, safeFileName } from "./files";
import { loadImagesOf } from "./images";
import { loadCanvasFonts, renderScene } from "./renderer";
import { buildSvg, fontsUsed } from "./svgExport";
import { fontFacesFor, measureBaselines } from "./svgFonts";

// Exporting a board: as a picture (PNG), as vectors (SVG), or as a board file
// (JSON) that can be imported again. Each resolves to false when the board is empty.

const MAX_DIMENSION = 8000;

export async function exportBoardAsPng(elements, fileName) {
  const bounds = getSceneBounds(elements);
  if (!bounds) return false;
  await Promise.all([loadCanvasFonts(), loadImagesOf(elements)]);

  const padding = 32;
  const width = bounds.width + padding * 2;
  const height = bounds.height + padding * 2;
  const scale = Math.min(2, MAX_DIMENSION / width, MAX_DIMENSION / height);

  const canvas = document.createElement("canvas");
  canvas.width = Math.ceil(width * scale);
  canvas.height = Math.ceil(height * scale);
  renderScene(canvas, {
    elements,
    viewport: { x: padding - bounds.x, y: padding - bounds.y, zoom: 1 },
    dpr: scale,
    background: "#ffffff",
  });

  const blob = await new Promise((resolve) => canvas.toBlob(resolve, "image/png"));
  downloadBlob(blob, `${safeFileName(fileName)}.png`);
  return true;
}

export async function exportBoardAsSvg(elements, fileName) {
  if (!getSceneBounds(elements)) return false;
  await loadCanvasFonts();
  const fonts = fontsUsed(elements);
  const [fontFaces, images] = await Promise.all([fontFacesFor(fonts), pictureDataUrls(elements)]);
  const svg = buildSvg(elements, { images, fontFaces, baselines: measureBaselines(fonts) });
  downloadBlob(new Blob([svg], { type: "image/svg+xml" }), `${safeFileName(fileName)}.svg`);
  return true;
}

export async function exportBoardAsJson(elements, title) {
  if (elements.length === 0) return false;
  const file = makeBoardFile({ title, elements, pictures: await pictureDataUrls(elements) });
  downloadBlob(
    new Blob([JSON.stringify(file)], { type: "application/json" }),
    `${safeFileName(title)}${BOARD_FILE_EXTENSION}`,
  );
  return true;
}
