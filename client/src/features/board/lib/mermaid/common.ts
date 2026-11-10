export class MermaidError extends Error {}

export const MAX_NODES = 500;
// Longer statements are left out (and counted): the patterns below take a long time on very long lines.
export const MAX_STATEMENT_LENGTH = 1000;

export function cleanLabel(raw: string): string {
  let text = raw.trim();
  if (text.startsWith('"') && text.endsWith('"') && text.length >= 2) text = text.slice(1, -1);
  if (text.startsWith("`") && text.endsWith("`") && text.length >= 2) text = text.slice(1, -1);
  return text
    .replace(/<br\s*\/?>/gi, "\n")
    .replace(/#(quot|35|59);/g, (_, code: string) => ({ quot: '"', 35: "#", 59: ";" })[code]!)
    .replace(/fa:fa-[\w-]+\s*/g, "")
    .trim();
}

function statements(text: string): string[] {
  const out: string[] = [];
  for (const line of text.split(/\r?\n/)) {
    let depth = 0;
    let quoted = false;
    let start = 0;
    for (let i = 0; i < line.length; i += 1) {
      const char = line[i];
      if (char === '"') quoted = !quoted;
      else if (!quoted && "[({".includes(char)) depth += 1;
      else if (!quoted && "])}".includes(char)) depth = Math.max(0, depth - 1);
      // The `;` of an entity (`#59;`) doesn't end a statement.
      else if (!quoted && depth === 0 && char === ";" && !/#\w{1,8}$/.test(line.slice(Math.max(start, i - 9), i))) {
        out.push(line.slice(start, i));
        start = i + 1;
      }
    }
    out.push(line.slice(start));
  }
  return out.map((statement) => statement.replace(/%%.*$/, "").trim()).filter(Boolean);
}

export const readStatements = (text: string) =>
  statements(text.replace(/^\s*---\r?\n[\s\S]*?\r?\n---[^\S\n]*(\r?\n|$)/, ""));

export type Measure = (text: string, fontSize: number) => { width: number; height: number };

export const estimate: Measure = (text, fontSize) => {
  const lines = text.split("\n");
  return {
    width: Math.max(...lines.map((line) => line.length)) * fontSize * 0.55,
    height: lines.length * fontSize * 1.25,
  };
};

export const FONT_SIZE = 20;
