import { readFile } from "node:fs/promises";
import { fileURLToPath } from "node:url";
import { transformWithOxc } from "vite";

// Lets tests import the app's .jsx and .tsx files, compiling them the way Vite does (Vite's own transform, which is
// a public export of vite, a declared dependency, unlike the compiler underneath it). It also strips a .tsx file's
// types, which Node can't do for a file with JSX in it.
// Registered by the tests that render components (see auth-pages.test.js); everything else goes through as usual.
export async function load(url, context, nextLoad) {
  if (!url.startsWith("file:") || !/\.[jt]sx$/.test(url)) return nextLoad(url, context);
  const path = fileURLToPath(url);
  // Throws, naming the file, when the code doesn't compile.
  const { code } = await transformWithOxc(await readFile(path, "utf8"), path, { jsx: { runtime: "automatic" } });
  return { format: "module", source: code, shortCircuit: true };
}

// The app's imports leave out ".jsx" and ".tsx" as well as ".js" and ".ts" (see resolve-hooks.js, which tries those).
const ENDINGS = [".jsx", ".tsx"];

export async function resolve(specifier, context, nextResolve) {
  try {
    return await nextResolve(specifier, context);
  } catch (error) {
    if (error.code !== "ERR_MODULE_NOT_FOUND" || !/^\.{1,2}\//.test(specifier) || /\.[a-z]+$/i.test(specifier)) {
      throw error;
    }
    for (const ending of ENDINGS) {
      try {
        return await nextResolve(`${specifier}${ending}`, context);
      } catch (missing) {
        if (missing.code !== "ERR_MODULE_NOT_FOUND") throw missing;
      }
    }
    throw error;
  }
}
