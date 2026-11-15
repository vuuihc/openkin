import reactHooks from "eslint-plugin-react-hooks";
import tseslint from "typescript-eslint";
import kin from "./eslint-rules/index.js";

/**
 * The added-file bans, off in `eslint.config.js` so `npm run lint` stays green
 * on legacy spellings. `scripts/ui_lint_guard.py` applies this config to added
 * `ui/src` files; tests, generated types and the facade are exempt.
 */
export default tseslint.config(
  // Global ignores: an object with only `ignores` applies to every later config.
  {
    ignores: [
      "dist/**",
      "node_modules/**",
      "src/api/generated/**",
      "src/components/ui/**",
      "src/**/*.test.{ts,tsx}",
    ],
  },
  {
    // Directives written for ordinary lint stay usable; unused ones are fine here.
    linterOptions: { reportUnusedDisableDirectives: "off" },
  },
  {
    files: ["src/**/*.{ts,tsx}"],
    languageOptions: {
      parser: tseslint.parser,
      parserOptions: { ecmaVersion: "latest", sourceType: "module", ecmaFeatures: { jsx: true } },
    },
    plugins: { kin, "react-hooks": reactHooks },
    rules: {
      "kin/no-raw-button": "error",
      "kin/no-create-portal": "error",
      "kin/no-arbitrary-z-index": "error",
      // Registered and on, so a new file's existing suppression resolves.
      "react-hooks/rules-of-hooks": "error",
      "react-hooks/exhaustive-deps": "warn",
    },
  },
);
