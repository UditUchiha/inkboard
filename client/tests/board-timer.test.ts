import assert from "node:assert/strict";
import { register } from "node:module";
import { describe, it } from "node:test";
import { createElement } from "react";
import { renderToStaticMarkup } from "react-dom/server";

register("./jsx-hooks.js", import.meta.url);
const { BoardTimer, StartTimer, formatTimeLeft, timeLeft } = await import("../src/features/board/BoardTimer.tsx");

const render = (props: Parameters<typeof BoardTimer>[0]) => renderToStaticMarkup(createElement(BoardTimer, props));
const onControl = () => {};

describe("the board's timer", () => {
  it("counts down by this browser's clock from when it heard", () => {
    const timer = { total: 60_000, left: 50_000, running: true, at: 1000 };
    assert.equal(timeLeft(timer, 11_000), 40_000);
    assert.equal(timeLeft(timer, 500), 50_000, "a clock read before it was heard of");
    assert.equal(timeLeft(timer, 99_000), 0);
    assert.equal(timeLeft({ ...timer, running: false }, 99_000), 50_000, "paused");
  });

  it("shows minutes and seconds, and hours past an hour, rounding up so 0:00 means done", () => {
    assert.equal(formatTimeLeft(300_000), "5:00");
    assert.equal(formatTimeLeft(65_001), "1:06");
    assert.equal(formatTimeLeft(400), "0:01");
    assert.equal(formatTimeLeft(0), "0:00");
    assert.equal(formatTimeLeft(3_723_000), "1:02:03");
  });

  it("shows nothing until a timer is started, from its own button", () => {
    assert.equal(render({ timer: null, canControl: true, onControl }), "");
    assert.match(renderToStaticMarkup(createElement(StartTimer, { onStart: () => {} })), /aria-label="Timer"/);
  });

  it("shows a paused timer to everyone, and its controls only to those who can set it", () => {
    const timer = { total: 300_000, left: 125_000, running: false, at: Date.now() };
    const viewer = render({ timer, canControl: false, onControl });
    assert.match(viewer, />2:05</);
    assert.doesNotMatch(viewer, /Resume timer|Stop timer/);
    assert.match(render({ timer, canControl: true, onControl }), /Resume timer.*Stop timer/);
  });

  it("says when time is up", () => {
    const timer = { total: 60_000, left: 0, running: false, at: Date.now() };
    const html = render({ timer, canControl: true, onControl });
    assert.match(html, /Time&#x27;s up/);
    assert.match(html, /Dismiss timer/);
    assert.doesNotMatch(html, /Resume timer/);
  });
});
