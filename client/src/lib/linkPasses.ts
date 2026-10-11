// The passes this browser was given for boards whose link asks for a password (see LinkPassReply), by board id,
// so the password isn't asked for again each visit. A pass stops working when the owner changes the password,
// and the board then asks again. Storage can be unavailable (a private window, blocked site data), and then
// the password is asked for each time the board opens.

const KEY = "inkboard.linkPasses";
// Enough for anyone's boards; the oldest are let go past it.
const MAX_PASSES = 100;

function readAll(): Record<string, string> {
  try {
    const stored: unknown = JSON.parse(localStorage.getItem(KEY) ?? "{}");
    return stored && typeof stored === "object" ? (stored as Record<string, string>) : {};
  } catch {
    return {};
  }
}

/** The pass saved for a board, if any. */
export function readPass(boardId: string): string | undefined {
  const pass = readAll()[boardId.toLowerCase()];
  return typeof pass === "string" && pass ? pass : undefined;
}

/** Saves the pass for a board (the newest last, so the oldest go first). */
export function savePass(boardId: string, pass: string) {
  const id = boardId.toLowerCase();
  const { [id]: _old, ...rest } = readAll();
  const kept = Object.entries(rest).slice(-(MAX_PASSES - 1));
  try {
    localStorage.setItem(KEY, JSON.stringify(Object.fromEntries([...kept, ...(pass ? [[id, pass]] : [])])));
  } catch {
    // Not saved: the board asks again next time.
  }
}
