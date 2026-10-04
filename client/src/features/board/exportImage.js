import { getSceneBounds } from "./elements";
import { loadCanvasFonts, renderScene } from "./renderer";

const MAX_DIMENSION = 8000;

export async function exportBoardAsPng(elements, fileName) {
  const bounds = getSceneBounds(elements);
  if (!bounds) return false;
  await loadCanvasFonts();

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
  const url = URL.createObjectURL(blob);
  const link = document.createElement("a");
  link.href = url;
  link.download = `${fileName.replace(/[\\/:*?"<>|]+/g, "-").trim() || "board"}.png`;
  link.click();
  setTimeout(() => URL.revokeObjectURL(url), 1000);
  return true;
}
