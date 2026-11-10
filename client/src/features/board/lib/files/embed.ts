// What the Share dialog gives people to show a board on another site (see EmbedPage).

const escapeAttribute = (text: string) =>
  text.replace(/&/g, "&amp;").replace(/"/g, "&quot;").replace(/</g, "&lt;").replace(/>/g, "&gt;");

/** The <iframe> that shows the board live on another site (see EmbedPage). */
export const embedCode = (origin: string, board: { id: string; title: string }) =>
  `<iframe src="${origin}/embed/${board.id}" title="${escapeAttribute(board.title)}" width="800" height="500" ` +
  `style="border:1px solid #d9dde3;border-radius:8px" allowfullscreen></iframe>`;
