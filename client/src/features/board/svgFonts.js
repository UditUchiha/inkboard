import archivoUrl from "@fontsource-variable/archivo/files/archivo-latin-wdth-normal.woff2?url";
import caveatUrl from "@fontsource-variable/caveat/files/caveat-latin-wght-normal.woff2?url";
import jetbrainsMonoUrl from "@fontsource-variable/jetbrains-mono/files/jetbrains-mono-latin-wght-normal.woff2?url";
import { FONTS } from "./constants";
import { dataUrlOf } from "./files";

// The text fonts, embedded in exported SVGs so text looks the same wherever the
// file is opened. Only the Latin set of each is embedded (40-90 KB apiece);
// other scripts fall back to the viewer's own fonts.
const FONT_FILES = {
  hand: { family: "Caveat Variable", url: caveatUrl, descriptors: "font-weight: 400 700;" },
  sans: { family: "Archivo Variable", url: archivoUrl, descriptors: "font-weight: 100 900; font-stretch: 62% 125%;" },
  code: { family: "JetBrains Mono Variable", url: jetbrainsMonoUrl, descriptors: "font-weight: 100 800;" },
};

/** @font-face rules, with the font files inlined, for the fonts (keys of FONTS) in `keys`. */
export async function fontFacesFor(keys) {
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

/**
 * Where each font's alphabetic baseline sits below the top of its em box, as a
 * share of the font size. The canvas draws text from that top; SVG text sits
 * on its baseline. Measured from a capital H in both modes; fonts must be loaded.
 */
export function measureBaselines(keys) {
  const context = document.createElement("canvas").getContext("2d");
  const baselines = {};
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
