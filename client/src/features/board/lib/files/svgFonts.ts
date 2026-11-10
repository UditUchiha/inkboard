import archivoUrl from "@fontsource-variable/archivo/files/archivo-latin-wdth-normal.woff2?url";
import caveatUrl from "@fontsource-variable/caveat/files/caveat-latin-wght-normal.woff2?url";
import jetbrainsMonoUrl from "@fontsource-variable/jetbrains-mono/files/jetbrains-mono-latin-wght-normal.woff2?url";
import type { Font } from "@inkboard/shared/types";
import { FONTS } from "../../constants/board";
import { dataUrlOf } from "./files";

// Embedded so text looks the same wherever the SVG is opened; only the Latin set of each (40-90 KB apiece), other
// scripts fall back to the viewer's fonts.
const FONT_FILES: Partial<Record<string, { family: string; url: string; descriptors: string }>> = {
  hand: { family: "Caveat Variable", url: caveatUrl, descriptors: "font-weight: 400 700;" },
  sans: { family: "Archivo Variable", url: archivoUrl, descriptors: "font-weight: 100 900; font-stretch: 62% 125%;" },
  code: { family: "JetBrains Mono Variable", url: jetbrainsMonoUrl, descriptors: "font-weight: 100 800;" },
};

export async function fontFacesFor(keys: Iterable<string>): Promise<string> {
  const rules = await Promise.all(
    [...keys].map(async (key) => {
      const font = FONT_FILES[key];
      if (!font) return "";
      const response = await fetch(font.url);
      if (!response.ok) return "";
      const data = await dataUrlOf(await response.blob());
      return `@font-face { font-family: "${font.family}"; font-style: normal; ${font.descriptors} src: url(${data}) format("woff2"); }`;
    }),
  );
  return rules.filter(Boolean).join("\n");
}

// Measured from a capital H in both modes; fonts must be loaded.
export function measureBaselines(keys: Iterable<Font>): Partial<Record<Font, number>> {
  const context = document.createElement("canvas").getContext("2d")!; // a canvas always gives a 2D context
  const baselines: Partial<Record<Font, number>> = {};
  for (const key of keys) {
    context.font = `100px ${FONTS[key].family}`;
    context.textBaseline = "top";
    const fromTop = context.measureText("H").actualBoundingBoxAscent;
    context.textBaseline = "alphabetic";
    const fromBaseline = context.measureText("H").actualBoundingBoxAscent;
    baselines[key] = (fromBaseline - fromTop) / 100;
  }
  return baselines;
}
