import assert from "node:assert/strict";
import { describe, it } from "node:test";

const { darkInk, darkRgb } = await import("../src/features/board/ink.js");

// Checked against Chromium's own `invert(93%) hue-rotate(180deg)` over 223 colors,
// which never differed by more than 2 of 255 in any channel.
describe("dark-mode ink", () => {
  it("turns black ink to chalk and white to near-black, as the CSS filter does", () => {
    assert.deepEqual(darkRgb([0, 0, 0]), [237, 237, 237]);
    assert.deepEqual(darkRgb([255, 255, 255]), [18, 18, 18]);
  });

  it("keeps greys grey and hues recognisable", () => {
    const [r, g, b] = darkRgb([128, 128, 128]);
    assert.ok(r === g && g === b);
    const red = darkRgb([224, 49, 49]);
    assert.ok(red[0] > red[1] + 60 && red[1] === red[2], `red stays red: ${red}`);
  });

  it("reads the color formats drawings and the renderer use", () => {
    assert.equal(darkInk("#000"), "rgb(237, 237, 237)");
    assert.equal(darkInk("#000000"), "rgb(237, 237, 237)");
    assert.equal(darkInk("#00000080"), "rgba(237, 237, 237, 0.5019607843137255)");
    assert.equal(darkInk("rgba(0, 0, 0, 0.12)"), "rgba(237, 237, 237, 0.12)");
    assert.equal(darkInk("rgb(0 0 0)"), "rgb(237, 237, 237)");
  });

  it("leaves anything else alone", () => {
    for (const value of ["transparent", "currentColor", "", undefined, null]) assert.equal(darkInk(value), value);
  });
});
