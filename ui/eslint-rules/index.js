/**
 * Two project rules, and the reason they are ESLint rules rather than more
 * cases in `src/design/tokens.test.ts`.
 *
 * The design guards and these rules say the same things about the same
 * vocabulary — they are not a second opinion, they are the same opinion at a
 * different time. A test tells you at `npm test`, which is after the file is
 * written, after the commit message, after the screenshots; by then the value
 * that skipped the ladder has already been copied twice. ESLint tells the
 * editor, which is where a class string is actually typed. Both are kept.
 *
 * The file sets are close but not identical, and the difference is worth
 * knowing before trusting one for the other: the tests scan `content` from
 * `tailwind.config.ts` (which includes `index.html` and `*.js`/`*.jsx`) with
 * `.css` added, while this config lints `src/**\/*.{ts,tsx}` and ignores
 * `src/api/generated/**`. Its two exemptions are not the same shape: tests
 * switch both rules off, while `src/design/` switches off `no-undefined-token`
 * and the colour-literal selector and leaves `no-arbitrary-literal` on — a
 * `text-[13px]` written in the design layer is still a finding. So a colour
 * literal in `index.html` is a *test* guard's business and not this lint's.
 *
 * They are deliberately narrow. `typescript-eslint`'s recommended set is not
 * turned on here: this is the design system's own vocabulary, and a lint that
 * also reports two hundred pre-existing style opinions is a lint somebody turns
 * off in the first week.
 */

/**
 * The colour classes: the utility prefixes that can take a `kin-*` colour.
 *
 * Written out rather than derived, unlike the ladders in the test — the
 * vocabulary here is Tailwind's own set of colour utilities, which no config of
 * ours declares (the config assigns the *colours*, not the utilities that spend
 * them). What the rule checks is that the name after the prefix is one of ours,
 * and that list is read from the config by `eslint.config.js` and passed in.
 */
const COLOUR_UTILITIES = [
  "bg",
  "text",
  "border",
  "ring",
  "outline",
  "fill",
  "stroke",
  "from",
  "via",
  "to",
  "divide",
  "decoration",
  "placeholder",
  "caret",
  "accent",
  // The side-lettered and offset forms. `border-t-kin-x` is the same axis as
  // `border-kin-x`, and leaving them out was a hole rather than a decision:
  // nothing in the tree uses one today, so nothing would have told us.
  ...["t", "r", "b", "l", "s", "e", "x", "y"].flatMap((side) => [
    `border-${side}`,
    `divide-${side}`,
  ]),
  "ring-offset",
];

/**
 * The two shapes `no-arbitrary-literal` refuses, mirroring guards 9 and 17.
 *
 * A font size written as a number (`text-[13px]`) and any arbitrary value on
 * the three axes that are vocabularies rather than rulers (`leading`,
 * `tracking`, `rounded`). Those axes have a word for every value in the tree,
 * so an arbitrary value there is not "off the scale", it is "no word for this"
 * — and it renders, which is what makes it survive.
 */
const OFF_LADDER = [
  {
    pattern: /(?<![\w-])text-\[[0-9.]+(?:px|rem|em|pt)\](?![\w-])/g,
    message:
      "a font size is one of the seven type roles in `design/type.ts` — `text-micro` through `text-hero`",
  },
  {
    pattern: /(?<![\w-])(?:leading|tracking|rounded(?:-(?:t|r|b|l|tl|tr|br|bl|s|e))?)-\[[^\]]+\]/g,
    message:
      "this axis is a vocabulary, not a ruler: every value in the tree has a name in `tailwind.config.ts`",
  },
];

/**
 * The width ladder, turned into one literal per step.
 *
 * The width axis is the half of this rule that cannot be a pattern. The axes
 * above are vocabularies — *every* arbitrary value on them is a finding — but
 * the widths are a ladder: most of the numbers in the tree are a label's
 * truncation cap or a control's size and are supposed to stay literals, so what
 * the rule refuses is one shape only, **a value the ladder already names**. That
 * is a fact about the config, not about the class string, so the list is read
 * out of `tailwind.config.ts` by `eslint.config.js` and passed in, the same way
 * the colour vocabulary is.
 *
 * Tailwind's content scan reads a class name, so a value is spelled without
 * spaces (`min(100%,420px)`) — but the config writes it the readable way
 * (`min(100%, 420px)`), and one value has two spellings in px and rem. Both
 * normalisations are here rather than in the caller: an entry that silently
 * failed to match would be a step nobody is held to.
 */
export function widthLiterals(axis, value) {
  const literal = (v) => `${axis}-[${v.replace(/\s+/g, "")}]`;
  const spellings = new Set([literal(value)]);
  const px = /^([\d.]+)px$/.exec(value);
  const rem = /^([\d.]+)rem$/.exec(value);
  if (px) {
    const remValue = Number(px[1]) / 16;
    if (Number.isFinite(remValue)) spellings.add(literal(`${Number(remValue.toFixed(4))}rem`));
  } else if (rem) {
    const pxValue = Number(rem[1]) * 16;
    if (Number.isFinite(pxValue)) spellings.add(literal(`${Number(pxValue.toFixed(4))}px`));
  }
  return [...spellings];
}

/**
 * Every string in a file that can hold a class list, as `{ node, value }`.
 *
 * Read from **nodes, not tokens**, and that is the whole point of this
 * function. A token walk looks for `String` and `Template` tokens, which is
 * what `className={"…"}` and `` className={`…`} `` produce — but a plain
 * `className="…"` produces a **`JSXText`** token, so a token walk never sees
 * it. That is not a corner: it is how a class list is spelled in the great
 * majority of this tree, so the rules were reporting only the rare spellings
 * and going quiet on the common one. `Literal` is the node for both JSX
 * attribute strings and ordinary string literals (its `value` is the unquoted
 * string either way), and `TemplateElement` is the quasi of a template — the
 * part that carries class names, where reading the whole template would splice
 * `${…}` expressions into the middle of a class list.
 */
function classSegments(context) {
  const sourceCode = context.sourceCode ?? context.getSourceCode();
  const segments = [];
  const visit = (node) => {
    if (!node || typeof node !== "object") return;
    if (Array.isArray(node)) {
      for (const child of node) visit(child);
      return;
    }
    if (node.type === "Literal" && typeof node.value === "string") {
      segments.push({ node, value: node.value });
    } else if (node.type === "TemplateElement") {
      segments.push({ node, value: node.value.cooked ?? node.value.raw });
    }
    for (const key of Object.keys(node)) {
      // `parent` is a cycle under some parsers, and `loc`/`range` are not
      // children. Everything else is walked, so no spelling is special-cased.
      if (key === "parent" || key === "loc" || key === "range") continue;
      visit(node[key]);
    }
  };
  visit(sourceCode.ast);
  return segments;
}

/** Report `kin-<name>` where `<name>` is not a colour the config declares. */
const noUndefinedToken = {
  meta: {
    type: "problem",
    docs: {
      description:
        "every kin-* colour class names a colour the Tailwind config declares, because a name the config does not declare emits no CSS at all",
    },
    schema: [
      {
        type: "object",
        properties: { colours: { type: "array", items: { type: "string" } } },
        required: ["colours"],
        additionalProperties: false,
      },
    ],
    messages: {
      undefined:
        "`{{name}}` is not a colour this console declares, so this class emits no CSS and the element keeps whatever it inherited. Declared names: see `theme.colors.kin` in `tailwind.config.ts`.",
    },
  },
  create(context) {
    const colours = context.options[0]?.colours ?? [];
    // No vocabulary is a misconfiguration, not a free pass: `eslint.config.js`
    // reads it out of the Tailwind config, so an empty list means the read
    // failed, and a rule that quietly passed every class would be worse than
    // no rule.
    if (colours.length === 0) {
      throw new Error("kin/no-undefined-token needs `colours` — see eslint.config.js");
    }
    // The name has to be one the config declares — exactly. A prefix test
    // (does the name start with a declared colour?) reads as the safer check
    // and is the looser one: `text-kin-blue-foo` extends a real name and emits
    // no CSS either, so it would have passed while being the same defect.
    const known = new Set(colours);
    const prefixes = COLOUR_UTILITIES.join("|");
    const pattern = new RegExp(`(?<![\\w-])(?:${prefixes})-kin-([a-z0-9-]+)`, "g");
    return {
      Program() {
        for (const segment of classSegments(context)) {
          for (const [match, name] of segment.value.matchAll(pattern)) {
            if (known.has(name)) continue;
            context.report({ node: segment.node, messageId: "undefined", data: { name: match } });
          }
        }
      },
    };
  },
};

/**
 * Refuse an arbitrary value on an axis the ladder has a word for.
 *
 * Two halves, and they fail for the same reason in different ways. The static
 * patterns are the axes where *every* value has a word; the width ladder is the
 * one axis where only the named values do — see `widthLiterals` for why that
 * cannot be a pattern. Both report the same defect: a class that renders, so it
 * looks right, and that no ladder can find again.
 */
const noArbitraryLiteral = {
  meta: {
    type: "problem",
    docs: {
      description: "no arbitrary value on a ladder that has a word for every value in the tree",
    },
    schema: [
      {
        type: "object",
        properties: {
          widths: {
            type: "array",
            items: {
              type: "object",
              properties: {
                axis: { type: "string" },
                name: { type: "string" },
                value: { type: "string" },
              },
              required: ["axis", "name", "value"],
              additionalProperties: false,
            },
          },
        },
        required: ["widths"],
        additionalProperties: false,
      },
    ],
    messages: {
      offLadder: "{{value}} — {{reason}}.",
      named: "{{value}} — this width already has a name: `{{name}}`. Use it, or add a step.",
    },
  },
  create(context) {
    const widths = context.options[0]?.widths ?? [];
    // As with the colours: no ladder is a misconfiguration, not a free pass.
    // `eslint.config.js` reads it out of the Tailwind config, so an empty list
    // means that read failed — and a width rule that quietly passed every class
    // would be worse than no width rule.
    if (widths.length === 0) {
      throw new Error("kin/no-arbitrary-literal needs `widths` — see eslint.config.js");
    }
    const named = widths.map(({ axis, name, value }) => ({
      name,
      pattern: new RegExp(
        `(?<![\\w-])${widthLiterals(axis, value)
          .map((literal) => literal.replace(/[.*+?^${}()|[\]\\]/g, "\\$&"))
          .join("|")}(?![\\w-])`,
        "g",
      ),
    }));
    return {
      Program() {
        for (const segment of classSegments(context)) {
          for (const { pattern, message } of OFF_LADDER) {
            pattern.lastIndex = 0;
            for (const [value] of segment.value.matchAll(pattern)) {
              context.report({
                node: segment.node,
                messageId: "offLadder",
                data: { value, reason: message },
              });
            }
          }
          for (const { name, pattern } of named) {
            pattern.lastIndex = 0;
            for (const [value] of segment.value.matchAll(pattern)) {
              context.report({
                node: segment.node,
                messageId: "named",
                data: { value, name: `${name}` },
              });
            }
          }
        }
      },
    };
  },
};

export default {
  rules: {
    "no-arbitrary-literal": noArbitraryLiteral,
    "no-undefined-token": noUndefinedToken,
  },
};
