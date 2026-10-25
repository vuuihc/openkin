import { createJiti } from "jiti";
import reactHooks from "eslint-plugin-react-hooks";
import tseslint from "typescript-eslint";
import resolveConfig from "tailwindcss/resolveConfig.js";
import kin from "./eslint-rules/index.js";

/**
 * The console's lint, which is the design system's vocabulary at edit time.
 *
 * Two scope decisions worth stating, because both are load-bearing:
 *
 * - **The colour vocabulary is read, not copied.** `theme.colors.kin` is loaded
 *   from `tailwind.config.ts` through jiti — the same file the build and the
 *   tests read, so a colour added to the config is a colour the rule knows
 *   about, and a name that stops existing is a name the rule starts reporting.
 *   A list written here would be the fourth copy of the palette.
 * - **The width ladder is read the same way**, and for a stronger reason: the
 *   rule refuses a width literal *because a step names that value*, so an
 *   unread ladder is not a stricter rule, it is a different one. It is read off
 *   `extend` and not off the resolved theme — see the note on `widths` below.
 * - **Test files are out of scope for the two project rules.** A test that
 *   asserts *about* a shape has to spell the shape: `tokens.test.ts` contains
 *   the patterns for the very literals it forbids, and `design/`'s render guard
 *   excludes tests from its content set for the same reason. The rules still
 *   run there — `no-restricted-syntax` below is about the design layer's own
 *   files — but the shape checks are switched off.
 */
const jiti = createJiti(import.meta.url);
const config = await jiti.import("./tailwind.config.ts", { default: true });
const theme = resolveConfig(config).theme;
const colours = Object.keys(theme.colors.kin).sort();
// The width ladder, in the shape the rule needs: one entry per step, with the
// utility prefix that spends it. Read from `extend` rather than from the
// resolved theme on purpose — the resolved `maxWidth` is mostly Tailwind's own
// scale (`max-w-xs` and friends), and those are not steps we are holding anyone
// to. See `widthLiterals` in `eslint-rules/index.js` for the other half.
const widths = [
  ["w", config.theme?.extend?.width],
  ["max-w", config.theme?.extend?.maxWidth],
  ["min-w", config.theme?.extend?.minWidth],
].flatMap(([axis, steps]) =>
  Object.entries(steps ?? {}).map(([name, value]) => ({ axis, name: `${axis}-${name}`, value })),
);

export default tseslint.config(
  { ignores: ["dist/**", "node_modules/**", "src/api/generated/**"] },
  {
    // Scoped to `src/**`, and that scope is load-bearing: these rules read every
    // string literal in a file they lint, and `eslint-rules/index.test.ts`
    // spells invalid classes on purpose — 27 hits against the current 32 cases.
    // That count tracks the case list, so re-measure it rather than trusting
    // this line; those fixtures are the point of that file, so the answer is to
    // keep it out here, not to teach the rules which strings are "real".
    files: ["src/**/*.{ts,tsx}"],
    languageOptions: {
      parser: tseslint.parser,
      parserOptions: { ecmaVersion: "latest", sourceType: "module", ecmaFeatures: { jsx: true } },
    },
    plugins: { kin, "react-hooks": reactHooks },
    rules: {
      "kin/no-undefined-token": ["error", { colours }],
      "kin/no-arbitrary-literal": ["error", { widths }],
      // Not a design rule, and here for the opposite reason: the tree already
      // carries `eslint-disable-next-line react-hooks/exhaustive-deps`
      // comments written when this config did not exist. A disable comment for
      // a rule nobody defines is an error in ESLint 9 — which is how this came
      // up — and the honest reading is that those comments were right and the
      // plugin was missing.
      "react-hooks/rules-of-hooks": "error",
      "react-hooks/exhaustive-deps": "warn",
      /**
       * Colour literals live in `src/design/`, and nowhere else.
       *
       * The design system's whole claim is that a colour has a name and the
       * name is where the decision is written down. A hex in a component is
       * that claim broken quietly: it renders, so it works, so it stays — and
       * it is invisible to every token guard, because there is no token to
       * check. Restricting the *directory* rather than listing the exceptions
       * is what keeps the rule from rotting: `src/design/` holds the token
       * layer, the ANSI palette for xterm, the heat ramp, the export
       * stylesheet, and the gallery's data, and everything outside it is a call
       * site — the gallery's own page (`src/pages/DesignSystemPage.tsx`)
       * included, which is why it is linted like any other page.
       *
       * Two selectors, because a literal has two spellings and they are
       * different node types: `Literal` is `"#fff"`, `TemplateElement` is the
       * quasi of `` `#fff` `` or `` `rgba(0,0,0,${a})` ``. Matching only the
       * first left the second — the spelling a computed colour is written in —
       * entirely unchecked, which is the same hole in a different place.
       *
       * Three things this deliberately does not cover, so that "nowhere else"
       * is not read as more than it is:
       *
       * - `ui/index.html` (the `theme-color` meta) and any `.css`. Only
       *   `src/**\/*.{ts,tsx}` is linted. The meta is pinned to `--kin-page` by
       *   a case in `tokens.test.ts` instead.
       * - `src/design/**`, which is where the literals are supposed to be.
       * - A `#` that starts a prose reference — `"see issue #300"` is reported,
       *   because `#300` is a valid three-digit hex and no pattern can tell the
       *   two apart. Reword rather than disable; the tree's only instance is in
       *   a comment, which is not linted.
       * - A template quasi is matched on `value.raw`, so an escape-encoded hex
       *   (`` `#fff` ``) is not seen. Contrived, and no such spelling
       *   exists here — but it is the one hole a selector cannot close.
       * - Conversely, a string that merely *reads* like source is reported: a
       *   module path, a URL or a log line containing a `kin-*` class or
       *   `text-[13px]`. That is the price of reading plain strings at all —
       *   and reading them is what makes `className="…"` visible — so the
       *   answer is to reword the string, not to narrow the selector.
       *
       * `theme.css`'s header names the four boundaries *inside* `src/design/`
       * and why each one is not a token.
       */
      "no-restricted-syntax": [
        "error",
        {
          selector:
            "Literal[value=/(?:^|[^\\w])#[0-9a-fA-F]{3,8}\\b|rgba?\\(|hsla?\\(|oklch\\(|oklab\\(|lab\\(|lch\\(/]",
          message:
            "a colour literal belongs in `src/design/` — use a token (`var(--kin-…)` or a `kin-*` class), or add one there",
        },
        {
          selector:
            "TemplateElement[value.raw=/(?:^|[^\\w])#[0-9a-fA-F]{3,8}\\b|rgba?\\(|hsla?\\(|oklch\\(|oklab\\(|lab\\(|lch\\(/]",
          message:
            "a colour literal belongs in `src/design/` — use a token (`var(--kin-…)` or a `kin-*` class), or add one there",
        },
      ],
    },
  },
  {
    files: ["**/*.test.{ts,tsx}"],
    rules: { "kin/no-undefined-token": "off", "kin/no-arbitrary-literal": "off" },
  },
  {
    // The design layer is where a colour literal is allowed, and it is also
    // where the rules above are *about* something — a rule that reported the
    // token layer's own files would be reporting its own subject.
    files: ["src/design/**/*.{ts,tsx}"],
    rules: { "no-restricted-syntax": "off", "kin/no-undefined-token": "off" },
  },
  {
    // Plain JS at the root: the rules themselves, and this file. They read
    // class strings out of source text on purpose.
    files: ["*.js", "eslint-rules/**/*.js"],
    languageOptions: { ecmaVersion: "latest", sourceType: "module" },
  },
);
