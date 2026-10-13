import { mathjax } from "@mathjax/src/js/mathjax.js";
import { liteAdaptor } from "@mathjax/src/js/adaptors/liteAdaptor.js";
import type { LiteElement } from "@mathjax/src/js/adaptors/lite/Element.js";
import { RegisterHTMLHandler } from "@mathjax/src/js/handlers/html.js";
import { TeX } from "@mathjax/src/js/input/tex.js";
import "@mathjax/src/js/input/tex/base/BaseConfiguration.js";
import "@mathjax/src/js/input/tex/ams/AmsConfiguration.js";
import "@mathjax/src/js/input/tex/boldsymbol/BoldsymbolConfiguration.js";
import "@mathjax/src/js/input/tex/newcommand/NewcommandConfiguration.js";
import "@mathjax/src/js/input/tex/noundefined/NoUndefinedConfiguration.js";
import { SVG } from "@mathjax/src/js/output/svg.js";
import type { Formula } from "./math";

// MathJax itself, loaded only by a board that has an equation on it (see math.ts).

/**
 * Makes the function that typesets TeX as a display equation. `loadFile` loads one of the font's
 * rarer parts (blackboard bold, fraktur…) by its module name, the first time a formula needs it.
 */
export function createTypesetter(loadFile: (name: string) => Promise<unknown>): (tex: string) => Promise<Formula> {
  mathjax.asyncLoad = loadFile;
  const adaptor = liteAdaptor();
  RegisterHTMLHandler(adaptor);
  const document = mathjax.document("", {
    InputJax: new TeX({ packages: ["base", "ams", "boldsymbol", "newcommand", "noundefined"] }),
    // Every glyph drawn as its own path, so a formula is a picture that needs no fonts and no other SVG.
    OutputJax: new SVG({ fontCache: "none" }),
  });
  return async (tex) => {
    // A mistake in the TeX comes back typeset too, as a red message, so the person can see what to fix.
    const node = await mathjax.handleRetriesFor(() => document.convert(tex, { display: true }));
    const svg = adaptor.firstChild(node) as LiteElement;
    const viewBox = adaptor.getAttribute(svg, "viewBox") as string;
    const [, , width, height] = viewBox.split(" ").map(Number);
    // The viewBox is in thousandths of an em.
    return { viewBox, body: adaptor.innerHTML(svg), width: width / 1000, height: height / 1000 };
  };
}
