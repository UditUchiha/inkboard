// The app's imports leave out the ".js" ending, which Vite fills in but Node doesn't.
// This lets the tests import app modules the same way the app does.
export async function resolve(specifier, context, nextResolve) {
  try {
    return await nextResolve(specifier, context);
  } catch (error) {
    const isRelative = /^\.{1,2}\//.test(specifier);
    const hasExtension = /\.[a-z]+$/i.test(specifier);
    if (error.code === "ERR_MODULE_NOT_FOUND" && isRelative && !hasExtension) {
      return nextResolve(`${specifier}.js`, context);
    }
    throw error;
  }
}
