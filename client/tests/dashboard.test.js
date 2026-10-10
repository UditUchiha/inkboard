import assert from "node:assert/strict";
import { describe, it } from "node:test";
import { compareBoards, daysLeft, isMember, SECTIONS } from "../src/features/dashboard/sections.ts";

const board = (overrides) => ({
  id: "x",
  title: "Board",
  role: "owner",
  starred: false,
  archived: false,
  updatedAt: "2026-01-01T00:00:00Z",
  lastOpenedAt: null,
  ...overrides,
});
const section = (id) => SECTIONS.find((item) => item.id === id);
const inSection = (id, boards) => boards.filter(section(id).matches).map((item) => item.title);

describe("dashboard sections", () => {
  const boards = [
    board({ title: "mine" }),
    board({ title: "shared", role: "editor" }),
    board({ title: "link", role: "viewer" }),
    board({ title: "editable link", role: "contributor" }),
    board({ title: "starred", starred: true }),
    board({ title: "archived", archived: true }),
    board({ title: "archived and starred", archived: true, starred: true, role: "editor" }),
  ];

  it("shows every board that isn't archived under All boards", () => {
    assert.deepEqual(inSection("all", boards), ["mine", "shared", "link", "editable link", "starred"]);
  });

  it("separates boards you own from boards shared with you, including link-opened ones", () => {
    assert.deepEqual(inSection("yours", boards), ["mine", "starred"]);
    assert.deepEqual(inSection("shared", boards), ["shared", "link", "editable link"]);
  });

  it("shows starred boards even when archived, and archived boards only in Archived", () => {
    assert.deepEqual(inSection("starred", boards), ["starred", "archived and starred"]);
    assert.deepEqual(inSection("archived", boards), ["archived", "archived and starred"]);
  });

  it("leaves no board unfindable", () => {
    for (const item of boards) {
      assert.ok(
        SECTIONS.some((candidate) => candidate.id !== "trash" && candidate.matches(item)),
        item.title,
      );
    }
  });

  it("knows which roles count as invited members", () => {
    assert.equal(isMember(board({ role: "owner" })), true);
    assert.equal(isMember(board({ role: "editor" })), true);
    assert.equal(isMember(board({ role: "contributor" })), false);
    assert.equal(isMember(board({ role: "viewer" })), false);
  });
});

describe("dashboard sorting", () => {
  const a = board({ title: "Alpha", updatedAt: "2026-03-01T00:00:00Z", lastOpenedAt: "2026-01-05T00:00:00Z" });
  const b = board({ title: "beta", updatedAt: "2026-01-01T00:00:00Z", lastOpenedAt: "2026-03-05T00:00:00Z" });
  const c = board({ title: "Gamma 10", updatedAt: "2026-02-01T00:00:00Z" });
  const d = board({ title: "Gamma 2", updatedAt: "2026-02-01T00:00:00Z" });
  const titles = (list, sort) => [...list].sort(compareBoards(sort)).map((item) => item.title);

  it("sorts by last modified, newest first by default", () => {
    assert.deepEqual(titles([a, b, c], { key: "modified", dir: "desc" }), ["Alpha", "Gamma 10", "beta"]);
    assert.deepEqual(titles([a, b, c], { key: "modified", dir: "asc" }), ["beta", "Gamma 10", "Alpha"]);
  });

  it("sorts by last opened, falling back to modified for boards never opened", () => {
    assert.deepEqual(titles([a, b, c], { key: "opened", dir: "desc" }), ["beta", "Gamma 10", "Alpha"]);
  });

  it("sorts titles ignoring case and reading numbers as numbers", () => {
    assert.deepEqual(titles([b, a, c, d], { key: "title", dir: "asc" }), ["Alpha", "beta", "Gamma 2", "Gamma 10"]);
    assert.deepEqual(titles([b, a], { key: "title", dir: "desc" }), ["beta", "Alpha"]);
  });

  it("breaks ties by title so the order is stable", () => {
    assert.deepEqual(titles([c, d], { key: "modified", dir: "desc" }), ["Gamma 2", "Gamma 10"]);
  });
});

describe("trash countdown", () => {
  it("counts whole days left, never below zero", () => {
    const inDays = (days) => new Date(Date.now() + days * 24 * 3600 * 1000 - 1000).toISOString();
    assert.equal(daysLeft(inDays(30)), 30);
    assert.equal(daysLeft(inDays(1)), 1);
    assert.equal(daysLeft(new Date(Date.now() - 5 * 24 * 3600 * 1000).toISOString()), 0);
  });
});
