// Numbers the browser and the server must agree on. Each used to be written out on both sides, so
// changing one and forgetting the other would have been a bug no test sees.

// The most elements a board can hold. The server drops what doesn't fit; the browser checks first
// so it can say so.
export const MAX_ELEMENTS_PER_BOARD = 5000;

// The rules for merging changes the current app follows (it says so when it joins a board): 2, each
// element's property groups carry their own stamps (see board-merge.js). A browser that doesn't say
// so is treated as running an older app.
export const SYNC_FORMAT = 2;

// What the server accepts of one picture (see docs/image-storage.md). The browser shrinks pictures
// to fit under these before it uploads.
export const IMAGE_MAX_BYTES = 2_000_000; // one stored picture
export const IMAGE_SMALL_MAX_BYTES = 200_000; // the small copy thumbnails draw from
export const IMAGE_MAX_SIDE = 4096; // pixels on the longer side of a picture
export const IMAGE_SMALL_MAX_SIDE = 512; // the same, for the small copy

// How many of its latest removals an open board remembers, on the server and in each browser that has
// it open. Each keeps a change made before the removal, and arriving after it, from bringing the
// element back; past this many the oldest are forgotten, so a long session doesn't keep growing.
export const MAX_REMOVALS_REMEMBERED = 50_000;
