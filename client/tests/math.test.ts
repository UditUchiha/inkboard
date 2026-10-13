import assert from "node:assert/strict";
import { describe, it } from "node:test";
import { mathSource } from "../src/features/board/math.ts";
import { createTypesetter } from "../src/features/board/mathjax.ts";

describe("mathSource", () => {
  it("reads the TeX of a text written between $$ signs", () => {
    assert.equal(mathSource(String.raw`$$\frac{a}{b}$$`), String.raw`\frac{a}{b}`);
    assert.equal(mathSource("  $$\n  x^2 + y^2 = r^2\n$$  "), "x^2 + y^2 = r^2");
  });

  it("gives an empty source for an empty equation", () => {
    assert.equal(mathSource("$$  $$"), "");
    assert.equal(mathSource("$$$$"), "");
  });

  it("leaves plain text alone", () => {
    assert.equal(mathSource("costs $5"), null);
    assert.equal(mathSource("$$"), null);
    assert.equal(mathSource("$$x$$ and more"), null);
    assert.equal(mathSource("$x$"), null);
  });
});

describe("createTypesetter", () => {
  // In Node, MathJax's font files load by their module names; the app maps them to Vite chunks.
  const typeset = createTypesetter((name) => import(name));

  it("typesets a formula as paths sized in ems", async () => {
    const formula = await typeset(String.raw`x = \frac{-b \pm \sqrt{b^2 - 4ac}}{2a}`);
    assert.ok(formula.width > 3 && formula.width < 20, `width ${formula.width}`);
    assert.ok(formula.height > 1 && formula.height < 5, `height ${formula.height}`);
    assert.match(formula.viewBox, /^-?[\d.]+ -?[\d.]+ [\d.]+ [\d.]+$/);
    assert.match(formula.body, /<path /);
    assert.doesNotMatch(formula.body, /<use |<image |<foreignObject|href=/);
  });

  it("loads the font's rarer parts when a formula needs them", async () => {
    const formula = await typeset(String.raw`\mathbb{R} \to \mathcal{L}`);
    assert.match(formula.body, /<path /);
    assert.doesNotMatch(formula.body, /<text /);
  });

  it("typesets a mistake as a message saying what's wrong", async () => {
    const formula = await typeset(String.raw`\frac{a`);
    assert.match(formula.body, /merror/);
    assert.ok(formula.width > 0);
  });
});
