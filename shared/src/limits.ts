// Numbers the browser and the server must agree on. Each used to be written out on both sides, so
// changing one and forgetting the other would have been a bug no test sees.

// The most elements a board can hold. The server drops what doesn't fit; the browser checks first
// so it can say so.
export const MAX_ELEMENTS_PER_BOARD = 5000;

// The longest a text (or a note's, or a label's) may be, a frame's name, and a picture's description. Two people's
// typing merged together is held to them too (see text-merge.ts).
export const MAX_TEXT_LENGTH = 20_000;
export const MAX_FRAME_NAME_LENGTH = 200;
export const MAX_ALT_LENGTH = 1000;

// The most votes each person can be given in a round of dot voting (see VotePayload in socket.ts).
export const MAX_VOTES_PER_PERSON = 20;
// What can be voted on: strokes, lines and arrows are how things are drawn and joined, not things to choose between.
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

// What a board keeps of suggestions (see docs/suggest-mode.md): how many can be open at once, on the
// board and from one person, and how much they may take up in all, measured as elements are. They don't
// count toward the board's own limits.
export const MAX_SUGGESTIONS_PER_BOARD = 300;
export const MAX_SUGGESTIONS_PER_AUTHOR = 100;
export const MAX_SUGGESTION_BYTES = 2_000_000;
// A suggestion nobody has accepted or rejected in this long is let go.
export const SUGGESTION_MAX_AGE_MS = 30 * 24 * 3600 * 1000;

// How many of its latest removals an open board remembers, on the server and in each browser that has
// it open. Each keeps a change made before the removal, and arriving after it, from bringing the
// element back; past this many the oldest are forgotten, so a long session doesn't keep growing.
export const MAX_REMOVALS_REMEMBERED = 50_000;

// A link's password: how long it may be. And how far ahead a link can be set to expire.
export const LINK_PASSWORD_MIN = 4;
export const LINK_PASSWORD_MAX = 100;
export const LINK_EXPIRY_MAX_MS = 366 * 24 * 3600 * 1000;

// Comments: how many threads a board can have, and the reactions a comment can be given.
export const MAX_THREADS_PER_BOARD = 500;
export const REACTION_EMOJI = ["👍", "❤️", "😂", "🎉", "👀", "✅"] as const;

/** The longest a board's timer can be set for: a whole day, in seconds (see CountdownPayload in socket.ts). */
export const MAX_COUNTDOWN_SECONDS = 24 * 60 * 60;
