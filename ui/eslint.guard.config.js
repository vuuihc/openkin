import reactHooks from "eslint-plugin-react-hooks";
import tseslint from "typescript-eslint";
import kin from "./eslint-rules/index.js";

/**
 * The added-file bans, kept out of `eslint.config.js` on purpose.
 *
 * `npm run lint` runs on the whole tree and must stay green on today's legacy
 * spellings. `scripts/ui_lint_guard.py` applies this config to the `ui/src`
 * files a change adds relative to its base, so new code cannot copy the shapes
 * the migration is removing. Reproduce a scoped run with:
 *
 *     cd ui
 *     npx eslint --config eslint.guard.config.js src/components/YourNewFile.tsx
 *
 * Tests spell controls and portals on purpose, generated API types are a build
 * artifact, and `src/components/ui/` is the facade where a raw control and a
 * portal are supposed to live. The runner leaves all three out as well.
 */
export default tseslint.config(
  // Global ignores: an object with only `ignores` is excluded from every later
  // config, so these files are not linted at all.
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
    // Disable directives written for ordinary lint must stay usable here; an
    // unused one is not a finding in a scoped run.
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
