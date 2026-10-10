import assert from "node:assert/strict";
import { describe, it } from "node:test";
import { describeElement } from "../src/features/board/elementLabels.js";
import { activeMentions, findMentions, isComposing, splitMentions } from "../src/features/board/mentions.js";
import { focusAfterClose } from "../src/features/board/popoverFocus.js";
import { titleToSave } from "../src/features/board/titleEdit.js";
import { DEFAULT_SORT, isSort, isView } from "../src/features/dashboard/sections.js";
import { readStored } from "../src/features/dashboard/useStoredState.js";
import { colorFor, initials, PEOPLE_COLORS, personColor, timeAgo } from "../src/lib/format.ts";
import { mergeNotifications, unreadIds } from "../src/lib/notifications.ts";

const storage = (entries) => ({
  getItem: (key) => (key in entries ? entries[key] : null),
});

describe("readStored (saved dashboard choices)", () => {
  it("falls back to the initial value when nothing is saved", () => {
    assert.equal(readStored("k", "grid", isView, storage({})), "grid");
  });

  it("returns a saved value that passes the check", () => {
    assert.equal(readStored("k", "grid", isView, storage({ k: '"list"' })), "list");
    const sort = { key: "title", dir: "asc" };
    assert.deepEqual(readStored("k", DEFAULT_SORT, isSort, storage({ k: JSON.stringify(sort) })), sort);
  });

  it("ignores values of the wrong shape instead of handing them to the page", () => {
    for (const saved of [
      "null",
      '"zigzag"',
      "42",
      '{"key":"size","dir":"asc"}',
      '{"key":"title"}',
      '{"key":"constructor","dir":"asc"}',
    ]) {
      assert.deepEqual(readStored("k", DEFAULT_SORT, isSort, storage({ k: saved })), DEFAULT_SORT, saved);
    }
    assert.equal(readStored("k", "grid", isView, storage({ k: '"table"' })), "grid");
  });

  it("ignores broken JSON and storage that throws", () => {
    assert.equal(readStored("k", "grid", isView, storage({ k: "{oops" })), "grid");
    const blocked = {
      getItem() {
        throw new Error("denied");
      },
    };
    assert.equal(readStored("k", "grid", isView, blocked), "grid");
    assert.equal(readStored("k", "grid", isView, undefined), "grid");
  });
});

describe("mentions", () => {
  it("does not count @Ann inside @Ann Lee, nor inside @Anna", () => {
    const text = "thanks @Ann Lee and @Anna";
    assert.deepEqual(
      findMentions(text, ["Ann", "Ann Lee", "Anna"]).map((m) => m.name),
      ["Ann Lee", "Anna"],
    );
    const members = [
      { id: "1", name: "Ann" },
      { id: "2", name: "Ann Lee" },
    ];
    assert.deepEqual(activeMentions("hi @Ann Lee", members, ["1", "2"]), ["2"]);
    assert.deepEqual(activeMentions("hi @Ann, see this", members, ["1", "2"]), ["1"]);
    assert.deepEqual(activeMentions("hi Ann", members, ["1", "2"]), []);
  });

  it("matches the longest name first whatever the order of the list", () => {
    assert.deepEqual(
      findMentions("@Ann Lee", ["Ann", "Ann Lee"]).map((m) => m.name),
      ["Ann Lee"],
    );
    assert.deepEqual(
      findMentions("@Ann Lee", ["Ann Lee", "Ann"]).map((m) => m.name),
      ["Ann Lee"],
    );
  });

  it("handles names with regex characters and repeated mentions", () => {
    const pieces = splitMentions("(@A.B) and @A.B!", ["A.B"]);
    assert.deepEqual(pieces, [
      { text: "(", mention: false },
      { text: "@A.B", mention: true },
      { text: ") and ", mention: false },
      { text: "@A.B", mention: true },
      { text: "!", mention: false },
    ]);
    assert.deepEqual(splitMentions("no mentions", ["Ann"]), [{ text: "no mentions", mention: false }]);
    assert.deepEqual(splitMentions("@Ann", []), [{ text: "@Ann", mention: false }]);
  });

  it("only counts an @ that starts a word, not one inside an email address", () => {
    const members = [{ id: "1", name: "Ann" }];
    assert.deepEqual(findMentions("mail a@Ann.com", ["Ann"]), []);
    assert.deepEqual(activeMentions("mail a@Ann.com", members, ["1"]), []);
    assert.deepEqual(splitMentions("a@Ann", ["Ann"]), [{ text: "a@Ann", mention: false }]);
    assert.deepEqual(
      findMentions("a@Ann then @Ann", ["Ann"]).map((m) => m.start),
      [11],
    );
    assert.deepEqual(activeMentions("@Ann", members, ["1"]), ["1"]);
  });

  it("knows when an input method is composing (Enter must not send then)", () => {
    assert.equal(isComposing({ nativeEvent: { isComposing: true }, keyCode: 13 }), true);
    assert.equal(isComposing({ nativeEvent: { isComposing: false }, keyCode: 229 }), true);
    assert.equal(isComposing({ nativeEvent: { isComposing: false }, keyCode: 13 }), false);
  });
});

describe("notifications merge", () => {
  const note = (id, minute, read = false) => ({ id, createdAt: `2026-01-01T00:${minute}:00Z`, read });

  it("merges by id, newest first, without duplicates", () => {
    const merged = mergeNotifications([note("b", "10"), note("a", "05")], [note("c", "20"), note("b", "10")]);
    assert.deepEqual(
      merged.map((item) => item.id),
      ["c", "b", "a"],
    );
  });

  it("never turns a read notification back into an unread one", () => {
    assert.equal(mergeNotifications([note("a", "05", true)], [note("a", "05", false)])[0].read, true);
    assert.equal(mergeNotifications([note("a", "05", false)], [note("a", "05", true)])[0].read, true);
  });

  it("keeps only the newest `limit` and lists unread ids", () => {
    const many = Array.from({ length: 5 }, (_, index) => note(`n${index}`, `0${index}`, index === 4));
    const merged = mergeNotifications(many, [], 3);
    assert.deepEqual(
      merged.map((item) => item.id),
      ["n4", "n3", "n2"],
    );
    assert.deepEqual(unreadIds(merged), ["n3", "n2"]);
  });
});

describe("timeAgo and initials", () => {
  const now = Date.parse("2026-01-01T12:00:00Z");
  const relative = new Intl.RelativeTimeFormat(undefined, { numeric: "auto" });

  it("describes dates relative to the given moment", () => {
    assert.equal(timeAgo("2026-01-01T11:55:00Z", now), relative.format(-5, "minute"));
    assert.equal(timeAgo("2025-12-30T12:00:00Z", now), relative.format(-2, "day"));
    assert.equal(timeAgo("2026-01-01T11:59:40Z", now), "just now");
  });

  it("takes initials without cutting emoji or accents in half", () => {
    assert.equal(initials("Ann Lee"), "AL");
    assert.equal(initials("  ann  "), "A");
    assert.equal(initials(""), "?");
    assert.equal(initials("émile zola"), "ÉZ");
    assert.equal(initials("👩‍💻 Dev"), "👩‍💻D");
    assert.equal(initials("Grace 🎉"), "G🎉");
  });
});

describe("person colors", () => {
  it("prefers the color someone chose, and falls back to one picked from their id", () => {
    assert.equal(personColor({ color: "#123456", userId: "u1" }), "#123456");
    assert.equal(personColor({ color: null, userId: "u1" }), colorFor("u1"));
    assert.equal(personColor({ id: "u2" }), colorFor("u2"));
  });

  it("keeps every color dark enough for white text (WCAG AA, 4.5:1)", () => {
    const luminance = (hex) => {
      const [r, g, b] = [1, 3, 5].map((at) => parseInt(hex.slice(at, at + 2), 16) / 255);
      const lin = (v) => (v <= 0.03928 ? v / 12.92 : ((v + 0.055) / 1.055) ** 2.4);
      return 0.2126 * lin(r) + 0.7152 * lin(g) + 0.0722 * lin(b);
    };
    for (const color of PEOPLE_COLORS) {
      assert.ok(1.05 / (luminance(color) + 0.05) >= 4.5, `${color} is too light for white text`);
    }
  });
});

describe("element labels for the keyboard list", () => {
  it("names elements by type and text", () => {
    assert.equal(describeElement({ type: "rectangle" }), "Rectangle");
    assert.equal(describeElement({ type: "sticky", text: "  Buy\nmilk " }), "Sticky note: Buy milk");
    assert.equal(describeElement({ type: "frame", name: "Sprint 4" }), "Frame: Sprint 4");
    assert.equal(describeElement({ type: "arrow", text: "yes" }), "Arrow: yes");
    assert.equal(describeElement({ type: "mystery" }), "Element");
  });

  it("shortens long text", () => {
    const label = describeElement({ type: "text", text: "x".repeat(500) });
    assert.ok(label.length < 80 && label.endsWith("…"));
  });
});

describe("board title rename", () => {
  it("doesn't save a title that was only clicked into, so someone else's rename stays", () => {
    // Focused while the board was "Plan", renamed to "Roadmap" by someone else, then left without typing.
    assert.equal(titleToSave("Plan", { current: "Roadmap", base: null }), null);
  });

  it("doesn't save text typed back to what it was", () => {
    assert.equal(titleToSave("Plan ", { current: "Roadmap", base: "Plan" }), null);
  });

  it("saves what was typed, trimmed, unless it's empty or already the name", () => {
    assert.equal(titleToSave("  Q3 plan ", { current: "Plan", base: "Plan" }), "Q3 plan");
    assert.equal(titleToSave("Q3 plan", { current: "Roadmap", base: "Plan" }), "Q3 plan");
    assert.equal(titleToSave("   ", { current: "Plan", base: "Plan" }), null);
    assert.equal(titleToSave("Roadmap", { current: "Roadmap", base: "Plan" }), null);
  });
});

describe("focus after a comment popover closes", () => {
  const inside = new Set(["field"]);
  const popover = { contains: (node) => inside.has(node) };
  const opener = { isConnected: true };

  it("returns to the opener when focus was inside the popover", () => {
    assert.equal(focusAfterClose(popover, "field", opener), opener);
  });

  it("leaves focus alone when it was elsewhere, such as the body after a click on the canvas", () => {
    assert.equal(focusAfterClose(popover, "body", opener), null);
    assert.equal(focusAfterClose(popover, null, opener), null);
  });

  it("does nothing when the opener is gone", () => {
    assert.equal(focusAfterClose(popover, "field", { isConnected: false }), null);
    assert.equal(focusAfterClose(popover, "field", null), null);
  });
});
