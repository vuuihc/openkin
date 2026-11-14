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
    // The three spellings of a class list, all read. The plain JSX attribute
    // is the one that matters: it is how the tree spells a class list in the
    // great majority of its call sites, and the first version of these rules
    // read tokens, which made it invisible — `className="…"` is a `JSXText`
    // token, not a `String` one, so only the braced spellings were checked.
    {
      code: 'const C = () => <button className="bg-kin-blue text-kin-muted" />;',
      options: [{ colours }],
    },
    { code: 'const C = () => <button className={"bg-kin-blue"} />;', options: [{ colours }] },
    {
      code: "const C = () => <button className={`bg-kin-elevated/60 ${x}`} />;",
      options: [{ colours }],
    },
    // The side-lettered form is the same axis, and every declared name that
    // contains a dash has to survive the exact-name check.
    {
      code: 'const a = "border-t-kin-hairline-strong divide-x-kin-fill md:ring-kin-focus-ring";',
      options: [{ colours }],
    },
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
    {
      // The spelling the rule used to be blind to.
      code: 'const C = () => <button className="flex bg-kin-purple" />;',
      options: [{ colours }],
      errors: [{ messageId: "undefined", data: { name: "bg-kin-purple" } }],
    },
    {
      // Extending a declared name is the same defect: `blue` exists,
      // `blue-foo` does not, and the class emits nothing either way.
      code: 'const a = "text-kin-blue-foo";',
      options: [{ colours }],
      errors: [{ messageId: "undefined", data: { name: "text-kin-blue-foo" } }],
    },
    {
      code: 'const a = "border-t-kin-nope";',
      options: [{ colours }],
      errors: [{ messageId: "undefined", data: { name: "border-t-kin-nope" } }],
    },
    // The other two spellings of a class list, failing rather than passing:
    // the valid cases above say "this one is read correctly", which is only
    // half a claim — a rule that ignored the spelling entirely would pass them
    // too, and that is exactly how the plain-attribute blind spot survived S6.
    {
      code: 'const C = () => <button className={"bg-kin-purple"} />;',
      options: [{ colours }],
      errors: [{ messageId: "undefined", data: { name: "bg-kin-purple" } }],
    },
    {
      code: "const C = () => <button className={`bg-kin-nope`} />;",
      options: [{ colours }],
      errors: [{ messageId: "undefined", data: { name: "bg-kin-nope" } }],
    },
  ],
});

// A slice of the width ladder, in the shape `eslint.config.js` builds: the
// value as the config writes it, spaces and all.
const widths = [
  { axis: "max-w", name: "max-w-page", value: "920px" },
  { axis: "max-w", name: "max-w-menu", value: "240px" },
  { axis: "max-w", name: "max-w-sheet", value: "min(100%, 420px)" },
  { axis: "min-w", name: "min-w-menu", value: "168px" },
  { axis: "w", name: "w-rail", value: "300px" },
];

tester.run("no-arbitrary-literal", kin.rules["no-arbitrary-literal"], {
  valid: [
    { code: 'const a = "text-body text-hero";', options: [{ widths }] },
    { code: 'const a = "rounded-lg leading-prose tracking-label";', options: [{ widths }] },
    // The axes with their own rules, and the widths that are *supposed* to stay
    // literal: a control's box, `min-h`'s 480, a label's truncation cap. The
    // last one is the difference between this rule and the two above it — a
    // width is refused only when a step already names the value.
    {
      code: 'const a = "max-w-[160px] min-h-[480px] gap-[3px] w-5 min-w-[44px]";',
      options: [{ widths }],
    },
    { code: 'const a = "max-w-[45%] sm:max-w-[18rem]";', options: [{ widths }] },
    // A `var()` is a token, and the axes that take one are read by name.
    { code: 'const a = "text-[var(--kin-text)]";', options: [{ widths }] },
    // The blind spot this rule shared with the one above, in its own axis: the
    // plain JSX attribute is where a size is actually typed.
    { code: 'const C = () => <div className="text-body leading-prose" />;', options: [{ widths }] },
  ],
  invalid: [
    {
      code: 'const a = "text-[13px]";',
      options: [{ widths }],
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
      options: [{ widths }],
      errors: [{ messageId: "offLadder" }],
    },
    {
      code: 'const a = "leading-[1.4] tracking-[0.02em]";',
      options: [{ widths }],
      errors: [{ messageId: "offLadder" }, { messageId: "offLadder" }],
    },
    {
      // The side-lettered form is the same axis.
      code: 'const a = "rounded-t-[3px]";',
      options: [{ widths }],
      errors: [{ messageId: "offLadder" }],
    },
    {
      code: 'const C = () => <div className="p-3 text-[13px]" />;',
      options: [{ widths }],
      errors: [{ messageId: "offLadder" }],
    },
    // Both other spellings, failing — see the note in the rule above.
    {
      code: 'const C = () => <div className={"p-3 text-[13px]"} />;',
      options: [{ widths }],
      errors: [{ messageId: "offLadder" }],
    },
    {
      code: "const C = () => <div className={`p-3 text-[13px]`} />;",
      options: [{ widths }],
      errors: [{ messageId: "offLadder" }],
    },
    // The width half. The first case is the whole message, because the fix is
    // the point of the rule and a `messageId` would not show that it names one.
    {
      code: 'const a = "mx-auto max-w-[920px] px-4";',
      options: [{ widths }],
      errors: [
        {
          message:
            "max-w-[920px] — this width already has a name: `max-w-page`. Use it, or add a step.",
        },
      ],
    },
    // The same value in the other unit: the config writes px, the tree may
    // write rem, and a step that only matched one spelling would be a step
    // nobody is held to.
    {
      code: 'const a = "max-w-[57.5rem]";',
      options: [{ widths }],
      errors: [{ messageId: "named", data: { value: "max-w-[57.5rem]", name: "max-w-page" } }],
    },
    // A variant prefix is not a different value.
    {
      code: 'const a = "sm:min-w-[168px]";',
      options: [{ widths }],
      errors: [{ messageId: "named", data: { value: "min-w-[168px]", name: "min-w-menu" } }],
    },
    // A config value with a space in it, written the way a class has to be.
    {
      code: 'const a = "max-w-[min(100%,420px)]";',
      options: [{ widths }],
      errors: [
        { messageId: "named", data: { value: "max-w-[min(100%,420px)]", name: "max-w-sheet" } },
      ],
    },
    // `min-w-` is not `w-`: the two axes hold different steps, and the
    // lookbehind is what keeps one from reading as the other.
    {
      code: 'const C = () => <div className={"w-[300px]"} />;',
      options: [{ widths }],
      errors: [{ messageId: "named", data: { value: "w-[300px]", name: "w-rail" } }],
    },
    {
      code: "const C = () => <div className={`max-w-[240px] min-w-[168px]`} />;",
      options: [{ widths }],
      errors: [{ messageId: "named" }, { messageId: "named" }],
    },
  ],
});
