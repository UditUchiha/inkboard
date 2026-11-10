// the server drops what doesn't fit; the browser checks first so it can say so
export const MAX_ELEMENTS_PER_BOARD = 5000;

// typing merged from two people is held to them too (see text-merge.ts)
export const MAX_TEXT_LENGTH = 20_000;
export const MAX_FRAME_NAME_LENGTH = 200;
export const MAX_ALT_LENGTH = 1000;

export const MAX_VOTES_PER_PERSON = 20;
// strokes, lines and arrows are how things are drawn and joined, not things to choose between
export const VOTABLE_TYPES: readonly string[] = [
  "sticky",
  "rectangle",
  "ellipse",
  "triangle",
  "diamond",
  "text",
  "image",
  "frame",
];

// 2: each element's property groups carry their own stamps; a browser that doesn't say so is treated as an older app
export const SYNC_FORMAT = 2;

// the browser shrinks pictures to fit under these before it uploads (see docs/image-storage.md)
export const IMAGE_MAX_BYTES = 2_000_000; // one stored picture
export const IMAGE_SMALL_MAX_BYTES = 200_000; // the small copy thumbnails draw from
export const IMAGE_MAX_SIDE = 4096; // pixels on the longer side of a picture
export const IMAGE_SMALL_MAX_SIDE = 512; // the same, for the small copy

// they don't count toward the board's own limits (see docs/suggest-mode.md)
export const MAX_SUGGESTIONS_PER_BOARD = 300;
export const MAX_SUGGESTIONS_PER_AUTHOR = 100;
export const MAX_SUGGESTION_BYTES = 2_000_000;
export const SUGGESTION_MAX_AGE_MS = 30 * 24 * 3600 * 1000;

// each keeps a change made before the removal, and arriving after it, from bringing the element back; past this the
// oldest are forgotten, so a long session doesn't keep growing
export const MAX_REMOVALS_REMEMBERED = 50_000;

export const LINK_PASSWORD_MIN = 4;
export const LINK_PASSWORD_MAX = 100;
export const LINK_EXPIRY_MAX_MS = 366 * 24 * 3600 * 1000;

export const MAX_THREADS_PER_BOARD = 500;
export const REACTION_EMOJI = ["👍", "❤️", "😂", "🎉", "👀", "✅"] as const;

export const MAX_COUNTDOWN_SECONDS = 24 * 60 * 60;
