import type { Element as BoardElement, TextElement } from "@inkboard/shared/types";
import { picturesChanged } from "./images";

// Equations. A text written as `$$…$$` is drawn as the TeX between the signs, typeset by MathJax.
// It stays a text everywhere else (the server, sync, the API), so nothing new is stored. MathJax
// is loaded the first time a board shows one, and the source is drawn until then.

/** A formula typeset by MathJax: what goes inside its <svg>, its viewBox, and its width and height in ems. */
export type Formula = { viewBox: string; body: string; width: number; height: number };

const FORMULA = /^\s*\$\$([\s\S]*?)\$\$\s*$/;

/** The TeX of a text written as `$$…$$` (empty for `$$ $$`), or null if it's plain text. */
export const mathSource = (text: string): string | null => FORMULA.exec(text)?.[1].trim() ?? null;

type Typeset = (tex: string) => Promise<Formula>;
type Entry = { formula: Formula | null; ready: Promise<void> };

let typesetter: Promise<Typeset> | undefined;
// shortcut: every formula typeset is kept for the session, with its pictures; fine for the few a board has,
// worth an LRU if boards with thousands of different equations turn up.
const formulas = new Map<string, Entry>(); // TeX -> its formula, once typeset
const pictures = new WeakMap<Formula, Map<string, HTMLImageElement>>(); // formula -> its picture in each color
const listeners = new Set<() => void>();

function loadTypesetter(): Promise<Typeset> {
  typesetter ??= import("./mathjax").then(({ createTypesetter }) => {
    // The font's rarer parts (blackboard bold, fraktur…), each a file of its own that MathJax asks for by module name.
    const files = import.meta.glob("../../../../node_modules/@mathjax/mathjax-newcm-font/mjs/svg/dynamic/*.js");
    return createTypesetter((name) => {
      const load =
        files[`../../../../node_modules/@mathjax/mathjax-newcm-font/mjs/svg/dynamic/${name.split("/").pop()}`];
      return load ? load() : Promise.reject(new Error(`No font file ${name}`));
    });
  });
  return typesetter;
}

function typeset(tex: string): Entry {
  const known = formulas.get(tex);
  if (known) return known;
  const created: Entry = { formula: null, ready: Promise.resolve() };
  created.ready = loadTypesetter()
    .then((run) => run(tex))
    .then((formula) => {
      created.formula = formula;
      // Its text now measures differently.
      for (const listener of listeners) listener();
      picturesChanged();
    })
    // Without MathJax (offline, say), the text is drawn as written.
    .catch((error: unknown) => console.warn("Couldn't typeset an equation", error));
  formulas.set(tex, created);
  return created;
}

/** The typeset formula a text is written as, starting it the first time; null for plain text or until it's ready. */
export function formulaOf(text: string): Formula | null {
  const tex = mathSource(text);
  return tex ? typeset(tex).formula : null;
}

/** Calls `listener` each time a formula is typeset, so measurements made from its source can be forgotten. */
export function onFormulaTypeset(listener: () => void): () => void {
  listeners.add(listener);
  return () => listeners.delete(listener);
}

/** The formula as a standalone SVG, `width` × `height` pixels, drawn in `color`. */
export const formulaSvg = (formula: Formula, color: string, width: number, height: number): string =>
  `<svg xmlns="http://www.w3.org/2000/svg" viewBox="${formula.viewBox}" width="${width}" height="${height}" color="${color}">${formula.body}</svg>`;

// The picture of a formula in a color, made the first time it's asked for.
function pictureOf(formula: Formula, color: string): HTMLImageElement {
  let byColor = pictures.get(formula);
  if (!byColor) pictures.set(formula, (byColor = new Map()));
  let image = byColor.get(color);
  if (!image) {
    image = new Image();
    image.onload = picturesChanged;
    // Big enough to stay sharp when it's drawn large.
    const scale = 96;
    image.src = `data:image/svg+xml;charset=utf-8,${encodeURIComponent(
      formulaSvg(formula, color, Math.ceil(formula.width * scale), Math.ceil(formula.height * scale)),
    )}`;
    byColor.set(color, image);
  }
  return image;
}

/** A picture of the formula in `color` to draw on a canvas, or null until it has loaded (canvases redraw then). */
export function formulaPicture(formula: Formula, color: string): HTMLImageElement | null {
  const image = pictureOf(formula, color);
  return image.complete && image.naturalWidth > 0 ? image : null;
}

/** Resolves once every equation in `elements` is typeset and its picture loaded, for an export. */
export async function loadFormulas(elements: readonly BoardElement[]): Promise<void> {
  const texts = elements.filter(
    (element): element is TextElement => element.type === "text" && Boolean(mathSource(element.text)),
  );
  // The assertion: each of these texts is a formula.
  await Promise.all(texts.map((element) => typeset(mathSource(element.text)!).ready));
  await Promise.all(
    texts.map((element) => {
      const formula = formulaOf(element.text);
      return (
        formula &&
        pictureOf(formula, element.stroke)
          .decode()
          .catch(() => {})
      );
    }),
  );
}
