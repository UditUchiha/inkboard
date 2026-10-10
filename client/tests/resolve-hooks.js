// The app's imports leave out the file's ending, which Vite fills in but Node doesn't.
// This lets the tests import app modules the same way the app does: as ".js", or ".ts" once a file is TypeScript
// (Node strips the types itself). Files with JSX in them are found by jsx-hooks.js.
const ENDINGS = [".js", ".ts"];

export async function resolve(specifier, context, nextResolve) {
  try {
    return await nextResolve(specifier, context);
  } catch (error) {
    const isRelative = /^\.{1,2}\//.test(specifier);
    const hasExtension = /\.[a-z]+$/i.test(specifier);
    if (error.code !== "ERR_MODULE_NOT_FOUND" || !isRelative || hasExtension) throw error;
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
