// The layout rules in AGENTS.md that a linter can't see. Run with `npm run check:structure`.
import { readdirSync, readFileSync, statSync } from "node:fs";
import path from "node:path";

const ROOT = path.resolve(import.meta.dirname, "..");
const SOURCE_DIRS = ["client/src", "server/src", "shared/src"];
const MAX_LINES = { ".tsx": 400, ".ts": 600 };
const FEATURE_FOLDERS = new Set(["components", "hooks", "lib", "constants", "types"]);
const APP_WIDE = ["client/src/components/", "client/src/hooks/", "client/src/lib/", "client/src/providers/"];

// Files still over the size limit. Remove an entry in the change that splits the file; never add one.
const SIZE_DEBT = new Set<string>([
  "client/src/features/board/components/BoardCanvas.tsx",
  "client/src/features/board/components/BoardEditor.tsx",
  "client/src/features/board/components/CommentsLayer.tsx",
  "client/src/features/board/components/PropertiesPanel.tsx",
  "client/src/features/board/components/ShareDialog.tsx",
  "client/src/features/board/hooks/useBoardSync.ts",
  "client/src/pages/DashboardPage.tsx",
  "server/src/realtime/index.ts",
]);

const walk = (dir: string, out: string[] = []): string[] => {
  for (const entry of readdirSync(dir)) {
    const full = path.join(dir, entry);
    if (statSync(full).isDirectory()) walk(full, out);
    else if (/\.(ts|tsx)$/.test(entry)) out.push(path.relative(ROOT, full).split(path.sep).join("/"));
  }
  return out;
};

const problems: string[] = [];
const files = SOURCE_DIRS.flatMap((dir) => walk(path.join(ROOT, dir)));

for (const file of files) {
  const text = readFileSync(path.join(ROOT, file), "utf8");
  const lines = text.split("\n").length;
  const limit = MAX_LINES[path.extname(file) as keyof typeof MAX_LINES];
  if (lines > limit && !SIZE_DEBT.has(file)) problems.push(`${file}: ${lines} lines (limit ${limit})`);
  if (lines <= limit && SIZE_DEBT.has(file)) problems.push(`${file}: now ${lines} lines, remove it from SIZE_DEBT`);

  const feature = /^client\/src\/features\/([^/]+)\/(.+)$/.exec(file);
  if (feature) {
    const [, name, rest] = feature;
    const [folder] = rest.split("/");
    if (!rest.includes("/") || !FEATURE_FOLDERS.has(folder)) {
      problems.push(`${file}: a feature file belongs in components/, hooks/, lib/, constants/ or types/`);
    }
    if (folder === "hooks" && !path.basename(file).startsWith("use"))
      problems.push(`${file}: hooks/ holds only use* hooks`);
    if (folder === "components" && !file.endsWith(".tsx")) problems.push(`${file}: components/ holds only .tsx files`);
    for (const [, other] of text.matchAll(/from "[./]*\/features\/([a-z-]+)\//g)) {
      if (other !== name && name === "board") problems.push(`${file}: board can't import the ${other} feature`);
    }
  }
  if (APP_WIDE.some((dir) => file.startsWith(dir)) && /from "[./]*\/?features\//.test(text)) {
    problems.push(`${file}: app-wide code can't import a feature`);
  }
}

for (const file of SIZE_DEBT) if (!files.includes(file)) problems.push(`${file}: listed in SIZE_DEBT but missing`);

if (problems.length > 0) {
  console.error(problems.join("\n"));
  console.error(`\n${problems.length} structure problem(s). See AGENTS.md § Project structure.`);
  process.exit(1);
}
console.log(`Structure OK (${files.length} files).`);
