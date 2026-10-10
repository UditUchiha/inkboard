import js from "@eslint/js";
import reactHooks from "eslint-plugin-react-hooks";
import globals from "globals";

// A small safety net, not a style guide (Prettier owns formatting): ESLint's recommended rules
// to catch unused and undefined names, plus the React hooks rules, which find stale closures.
export default [
  { ignores: ["**/dist/", "**/node_modules/", "server/.data/", "client/public/"] },
  js.configs.recommended,
  {
    languageOptions: { ecmaVersion: "latest", sourceType: "module", globals: globals.node },
    linterOptions: { reportUnusedDisableDirectives: "error" },
    rules: {
      // `_name` marks a value that is deliberately unused (a skipped argument or destructured field).
      "no-unused-vars": ["error", { argsIgnorePattern: "^_", varsIgnorePattern: "^_", caughtErrors: "none" }],
    },
  },
  {
    files: ["client/src/**/*.{js,jsx}"],
    plugins: { "react-hooks": reactHooks },
    languageOptions: {
      parserOptions: { ecmaFeatures: { jsx: true } },
      globals: globals.browser,
    },
    // Only the two long-standing rules. The plugin's newer React Compiler rules (no setState in an effect,
    // no ref writes while rendering) flag patterns that are deliberate and fine here, since the app doesn't use the compiler.
    rules: { "react-hooks/rules-of-hooks": "error", "react-hooks/exhaustive-deps": "error" },
  },
  {
    files: ["client/vite.config.js", "client/tests/**", "server/**", "shared/**"],
    languageOptions: { globals: globals.node },
  },
];
