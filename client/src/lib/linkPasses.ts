// Passes for boards whose link asks for a password, by board id, so it isn't asked each visit; a pass stops working when the owner changes
// the password. Without storage (private window, blocked data) the password is asked each time.

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

export function readPass(boardId: string): string | undefined {
  const pass = readAll()[boardId.toLowerCase()];
  return typeof pass === "string" && pass ? pass : undefined;
}

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
