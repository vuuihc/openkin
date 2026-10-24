import { RuleTester } from "eslint";
import tseslint from "typescript-eslint";
import { afterAll, describe, it } from "vitest";
import kin from "./index.js";

/**
 * The rules, against their own cases rather than against the tree.
 *
 * The tree is the other half and it is a different question: `npm run lint`
 * proves the tree satisfies the rules today, and these prove the rules can
 * fail. Both are needed — a rule with no failing case is a rule whose
 * `create()` might be returning `{}` — and neither is a substitute for the
 * other. The cases below are written as the smallest source that shows the
 * difference between the two.
 */
RuleTester.describe = describe;
RuleTester.it = it;
RuleTester.itOnly = it.only;
RuleTester.afterAll = afterAll;

const tester = new RuleTester({
  languageOptions: {
    parser: tseslint.parser,
    parserOptions: { ecmaVersion: "latest", sourceType: "module", ecmaFeatures: { jsx: true } },
  },
});

// A slice of `theme.colors.kin`, including the names that read like other
// things (`text`, `hairline`) — the first version of this fixture left them
// out, and the rule correctly reported a class that does exist.
const colours = [
  "bg",
  "blue",
  "blue-ink",
  "elevated",
  "fill",
  "focus-ring",
  "hairline",
  "hairline-strong",
  "muted",
  "on-brand",
  "text",
];

tester.run("no-undefined-token", kin.rules["no-undefined-token"], {
  valid: [
    { code: 'const a = "bg-kin-blue text-kin-muted";', options: [{ colours }] },
    { code: "const a = `bg-kin-elevated/60 ${x}`;", options: [{ colours }] },
    { code: 'const a = "hover:bg-kin-blue/15 ring-kin-focus-ring";', options: [{ colours }] },
    // Not a colour utility: `kin-btn` is a component class in `index.css`, and
    // `--kin-blue` is a token reference, not a class.
    { code: 'const a = "kin-btn kin-btn-primary";', options: [{ colours }] },
    {
      code: 'const a = "bg-[var(--kin-fill)] border-[var(--kin-hairline)]";',
      options: [{ colours }],
    },
    // A dead name in prose is not a call site.
    { code: 'const doc = "write bg-kin-* here";', options: [{ colours }] },
  ],
  invalid: [
    {
      code: 'const a = "text-kin-primary";',
      options: [{ colours }],
      errors: [{ messageId: "undefined", data: { name: "text-kin-primary" } }],
    },
    {
      // The shape the guard caught in S4: `purple` was never a colour.
      code: 'const a = "bg-kin-purple text-kin-text";',
      options: [{ colours }],
      errors: [{ messageId: "undefined", data: { name: "bg-kin-purple" } }],
    },
    {
      code: "const a = `border-kin-hairline md:text-kin-tertiary`;",
      options: [{ colours }],
      errors: [{ messageId: "undefined", data: { name: "text-kin-tertiary" } }],
    },
    {
      code: 'const a = "from-kin-nowhere";',
      options: [{ colours }],
      errors: [{ messageId: "undefined", data: { name: "from-kin-nowhere" } }],
    },
  ],
});

tester.run("no-arbitrary-literal", kin.rules["no-arbitrary-literal"], {
  valid: [
    { code: 'const a = "text-body text-hero";' },
    { code: 'const a = "rounded-lg leading-prose tracking-label";' },
    // Not a ladder axis: the layout widths and `min-h` have their own rules.
    { code: 'const a = "max-w-[720px] min-h-[480px] gap-[3px]";' },
    { code: 'const a = "max-w-[min(100%,420px)]";' },
    // A `var()` is a token, and the axes that take one are read by name.
    { code: 'const a = "text-[var(--kin-text)]";' },
  ],
  invalid: [
    {
      code: 'const a = "text-[13px]";',
      // The whole message, once: the rule's value is in *what* it names, and
      // `messageId` alone would not show that the axis is in the text.
      errors: [
        {
          message:
            "text-[13px] — a font size is one of the seven type roles in `design/type.ts` — `text-micro` through `text-hero`.",
        },
      ],
    },
    {
      code: 'const a = "rounded-[6px] px-3";',
      errors: [{ messageId: "offLadder" }],
    },
    {
      code: 'const a = "leading-[1.4] tracking-[0.02em]";',
      errors: [{ messageId: "offLadder" }, { messageId: "offLadder" }],
    },
    {
      // The side-lettered form is the same axis.
      code: 'const a = "rounded-t-[3px]";',
      errors: [{ messageId: "offLadder" }],
    },
  ],
});
