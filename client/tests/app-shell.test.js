import assert from "node:assert/strict";
import { afterEach, beforeEach, describe, it } from "node:test";
import { isView } from "../src/features/dashboard/sections.ts";
import { fillPreviews } from "../src/features/dashboard/useBoards.ts";
import { readStored, writeStored } from "../src/features/dashboard/useStoredState.ts";
import { isChunkLoadError, reloadOnce, resetReloadOnce, withReload } from "../src/lib/chunkReload.ts";
import { contrastWithWhite, PEOPLE_COLORS, personColor, readableColor } from "../src/lib/format.ts";
import { mergeNotifications, withNewestPage } from "../src/lib/notifications.ts";

describe("saved choices with site data blocked", () => {
  let original;
  beforeEach(() => {
    original = Object.getOwnPropertyDescriptor(globalThis, "localStorage");
    // What Chrome does when cookies and site data are blocked: merely reading `localStorage` throws.
    Object.defineProperty(globalThis, "localStorage", {
      configurable: true,
      get() {
        throw new DOMException("Access is denied for this document.", "SecurityError");
      },
    });
  });
  afterEach(() => {
    if (original) Object.defineProperty(globalThis, "localStorage", original);
    else delete globalThis.localStorage;
  });

  it("reads the initial value instead of throwing", () => {
    assert.equal(readStored("inkboard.dashboard.view", "grid", isView), "grid");
  });

  it("writes nothing and doesn't throw", () => {
    assert.doesNotThrow(() => writeStored("inkboard.dashboard.view", "list"));
  });
});

describe("reloading after a deploy replaced the app's files", () => {
  const memory = (entries = {}) => {
    const store = { ...entries };
    return {
      store,
      storage: () => ({
        getItem: (key) => store[key] ?? null,
        setItem: (key, value) => {
          store[key] = value;
        },
      }),
    };
  };
  const chunkError = () => new TypeError("Failed to fetch dynamically imported module: https://x/assets/Board-1.js");

  afterEach(resetReloadOnce);

  it("recognises failed downloads of code in each browser, and nothing else", () => {
    assert.ok(isChunkLoadError(chunkError()));
    assert.ok(isChunkLoadError(new TypeError("error loading dynamically imported module")));
    assert.ok(isChunkLoadError(new TypeError("Importing a module script failed.")));
    assert.ok(isChunkLoadError(new Error("Unable to preload CSS for /assets/index-1.css")));
    assert.ok(!isChunkLoadError(new TypeError("Cannot read properties of undefined")));
    assert.ok(!isChunkLoadError(null));
  });

  it("reloads once, then not again within the wait, then again after it", () => {
    const { storage } = memory();
    let reloads = 0;
    const reload = () => (reloads += 1);
    assert.equal(reloadOnce({ storage, now: 1000, reload }), true);
    resetReloadOnce(); // the new page
    assert.equal(reloadOnce({ storage, now: 5000, reload }), false);
    assert.equal(reloads, 1);
    assert.equal(reloadOnce({ storage, now: 60_000, reload }), true);
    assert.equal(reloads, 2);
  });

  it("stops after two reloads in a few minutes, even when each failed slowly", () => {
    const { storage } = memory();
    let reloads = 0;
    const reload = () => (reloads += 1);
    // A request that hangs ~30s before failing is never "fast", so only the cap stops this loop.
    for (const now of [0, 30_000, 60_000, 90_000]) {
      reloadOnce({ storage, now, reload });
      resetReloadOnce();
    }
    assert.equal(reloads, 2);
    // After the window passes, a later deploy can reload again.
    assert.equal(reloadOnce({ storage, now: 400_000, reload }), true);
    assert.equal(reloads, 3);
  });

  it("ignores saved reload times that aren't a list of numbers", () => {
    for (const saved of ["1000", "not json", '{"a":1}', '["x",null]']) {
      resetReloadOnce();
      const { storage } = memory({ "inkboard.chunkReloads": saved });
      let reloads = 0;
      assert.equal(reloadOnce({ storage, now: 5000, reload: () => (reloads += 1) }), true, saved);
      assert.equal(reloads, 1);
    }
  });

  it("only asks once while a reload is under way", () => {
    const { storage } = memory();
    let reloads = 0;
    const reload = () => (reloads += 1);
    assert.equal(reloadOnce({ storage, now: 1000, reload }), true);
    assert.equal(reloadOnce({ storage, now: 1001, reload }), true);
    assert.equal(reloads, 1);
  });

  it("doesn't reload without session storage, since a loop couldn't be stopped", () => {
    let reloads = 0;
    const storage = () => {
      throw new DOMException("Access is denied for this document.", "SecurityError");
    };
    assert.equal(reloadOnce({ storage, now: 1000, reload: () => (reloads += 1) }), false);
    assert.equal(reloads, 0);
  });

  it("keeps a lazy page loading while the app reloads, and passes other errors on", async () => {
    let settled = false;
    withReload(
      () => Promise.reject(chunkError()),
      () => true,
    )().finally(() => (settled = true));
    await new Promise((resolve) => setTimeout(resolve, 10));
    assert.equal(settled, false);

    await assert.rejects(
      withReload(
        () => Promise.reject(chunkError()),
        () => false,
      )(),
      /dynamically imported/,
    );
    await assert.rejects(
      withReload(
        () => Promise.reject(new Error("bug")),
        () => true,
      )(),
      /bug/,
    );
    assert.deepEqual(
      await withReload(
        () => Promise.resolve({ default: 1 }),
        () => true,
      )(),
      { default: 1 },
    );
  });
});

describe("notification pages", () => {
  const note = (id, minute, read = false) => ({ id, read, createdAt: `2026-01-01T00:${minute}:00Z` });

  it("keeps older pages when a live one arrives", () => {
    const loaded = Array.from({ length: 45 }, (_, index) => note(`n${index}`, String(index).padStart(2, "0")));
    assert.equal(mergeNotifications(loaded, [note("live", "59")]).length, 46);
  });

  it("starts over from the newest page after a reconnect, keeping what arrived live", () => {
    const current = [note("live", "50"), note("a", "40"), note("old", "05")];
    const page = [note("b", "45"), note("a", "40", true)];
    assert.deepEqual(
      withNewestPage(current, page).map((item) => [item.id, item.read]),
      [
        ["live", false],
        ["b", false],
        ["a", true],
      ],
    );
  });

  it("keeps everything when the newest page is empty (a page skipped because its senders are gone)", () => {
    const current = [note("live", "50"), note("a", "40", true)];
    assert.deepEqual(withNewestPage(current, []), current);
    assert.deepEqual(withNewestPage([], []), []);
  });
});

describe("dashboard previews", () => {
  it("puts a preview only on the version of the board it was asked for", () => {
    const found = new Map([
      ["a@2026-01-01T00:00:00Z", ["a-old"]],
      ["b@2026-01-01T00:00:00Z", ["b-now"]],
    ]);
    const list = [
      { id: "a", updatedAt: "2026-01-02T00:00:00Z" }, // refreshed while its preview was on its way
      { id: "b", updatedAt: "2026-01-01T00:00:00Z" },
      { id: "c", updatedAt: "2026-01-01T00:00:00Z" },
    ];
    assert.deepEqual(
      fillPreviews(list, found).map((board) => board.preview),
      [undefined, ["b-now"], undefined],
    );
    assert.equal(fillPreviews(null, found), undefined);
  });
});

describe("people colors with white text", () => {
  const rgb = (hex) => [1, 3, 5].map((start) => Number.parseInt(hex.slice(start, start + 2), 16));

  it("maps colors from the old palette to the ones that replaced them", () => {
    assert.equal(readableColor("#f08c00"), "#946200");
    assert.equal(readableColor("#E8590C"), "#c2410c");
    assert.equal(personColor({ id: "u1", color: "#2f9e44" }), "#237a35");
    for (const color of PEOPLE_COLORS) assert.equal(readableColor(color), color);
  });

  it("darkens any other color too light for white text, and leaves dark ones and no color alone", () => {
    for (const color of ["#ffffff", "#ffd43b", "#74c0fc", "#40c057", "#ff8787"]) {
      const readable = readableColor(color);
      assert.match(readable, /^#[0-9a-f]{6}$/);
      assert.ok(contrastWithWhite(rgb(readable)) >= 4.5, `${color} -> ${readable}`);
    }
    assert.equal(readableColor("#123456"), "#123456");
    assert.equal(readableColor(null), null);
    assert.equal(readableColor(undefined), undefined);
  });
});
