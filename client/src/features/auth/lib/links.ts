export const nextQuery = (next: string | null) => (next ? `?next=${encodeURIComponent(next)}` : "");

// Signing up from a guest board brings the drawing along (see DrawPage).
export const savingDrawing = (next: string | null) => next === "/draw";
