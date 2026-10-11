import assert from "node:assert/strict";
import { describe, it } from "node:test";
import { isOverlayKey, isPressable, isTypingTarget } from "../src/features/board/domTargets.ts";

// There's no DOM here: just enough of one for the selectors domTargets uses (tags, [attr], [attr='value']).
function matches(element: FakeElement, selector: string) {
  return selector.split(",").some((part: string) => {
    const [, tag, attributes] = /^\s*([a-z]*)((?:\[[^\]]+\])*)\s*$/i.exec(part)!;
    if (tag && element.tagName !== tag.toUpperCase()) return false;
    for (const [, name, value] of attributes!.matchAll(/\[([\w-]+)(?:='([^']*)')?\]/g)) {
      const actual = element.attributes[name!];
      if (actual === undefined || (value !== undefined && actual !== value)) return false;
    }
    return true;
  });
}

class FakeElement {
  declare tagName: string;
  declare attributes: Record<string, string>;
  declare type: string;
  declare isContentEditable: boolean;
  declare parent: FakeElement | HTMLElement | null;

  constructor(tag: string, attributes: Record<string, string> = {}, parent: FakeElement | HTMLElement | null = null) {
    this.tagName = tag.toUpperCase();
    this.attributes = attributes;
    this.type = attributes.type ?? (this.tagName === "INPUT" ? "text" : "");
    this.isContentEditable = attributes.contenteditable === "true";
    this.parent = parent;
  }

  closest(selector: string): FakeElement | HTMLElement | null {
    for (let element: FakeElement | HTMLElement | null = this; element; element = (element as FakeElement).parent)
      if (matches(element as FakeElement, selector)) return element;
    return null;
  }
}
globalThis.HTMLElement = FakeElement as unknown as typeof HTMLElement;

const el = (tag: string, attributes?: Record<string, string>, parent?: FakeElement | HTMLElement | null) =>
  new FakeElement(tag, attributes, parent) as unknown as HTMLElement;
const page = (...open: (FakeElement | HTMLElement)[]) =>
  ({
    querySelector: (selector: string) => open.find((element) => matches(element as FakeElement, selector)) ?? null,
  }) as unknown as ParentNode;

describe("typing targets", () => {
  it("are text fields, not color pickers or checkboxes", () => {
    assert.equal(isTypingTarget(el("input")), true);
    assert.equal(isTypingTarget(el("textarea")), true);
    assert.equal(isTypingTarget(el("div", { contenteditable: "true" })), true);
    assert.equal(isTypingTarget(el("input", { type: "color" })), false);
    assert.equal(isTypingTarget(el("input", { type: "checkbox" })), false);
    assert.equal(isTypingTarget(el("button")), false);
  });
});

describe("pressable targets (Space and Enter are theirs)", () => {
  it("include a focused color picker, so Space opens it instead of arming pan mode", () => {
    assert.equal(isPressable(el("input", { type: "color" })), true);
  });

  it("include buttons, links, and inputs Space ticks or presses", () => {
    assert.equal(isPressable(el("span", {}, el("button"))), true);
    assert.equal(isPressable(el("a", { href: "/boards" })), true);
    assert.equal(isPressable(el("div", { role: "button" })), true);
    for (const type of ["checkbox", "radio", "file", "button", "submit", "reset"]) {
      assert.equal(isPressable(el("input", { type })), true, type);
    }
  });

  it("leave out the board, text fields and plain links", () => {
    assert.equal(isPressable(el("div")), false);
    assert.equal(isPressable(el("input")), false);
    assert.equal(isPressable(el("a")), false);
    assert.equal(isPressable(null), false);
  });
});

describe("keys that belong to something over the board", () => {
  const board = el("div");

  it("go to the board when nothing is open", () => {
    assert.equal(isOverlayKey(board, page()), false);
  });

  it("go to a comment popover when focus is inside it, but not when focus is back on the board", () => {
    const popover = el("div", { role: "dialog" });
    const resolve = el("button", {}, popover);
    assert.equal(isOverlayKey(popover, page(popover)), true);
    assert.equal(isOverlayKey(resolve, page(popover)), true);
    assert.equal(isOverlayKey(board, page(popover)), false);
  });

  it("go to an open menu or modal dialog wherever focus is", () => {
    assert.equal(isOverlayKey(board, page(el("dialog", { open: "" }))), true);
    assert.equal(isOverlayKey(board, page(el("div", { role: "menu" }))), true);
    assert.equal(isOverlayKey(board, page(el("div", { "aria-modal": "true" }))), true);
    assert.equal(isOverlayKey(board, page(el("dialog"))), false);
  });
});
