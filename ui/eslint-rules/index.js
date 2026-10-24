/**
 * Two project rules, and the reason they are ESLint rules rather than more
 * cases in `src/design/tokens.test.ts`.
 *
 * The design guards and these rules say the same things about the same tree —
 * they are not a second opinion, they are the same opinion at a different time.
 * A test tells you at `npm test`, which is after the file is written, after the
 * commit message, after the screenshots; by then the value that skipped the
 * ladder has already been copied twice. ESLint tells the editor, which is where
 * a class string is actually typed. Both are kept, and the trees they read are
 * the same one (`content` in `tailwind.config.ts`) so they cannot disagree
 * about which files they are looking at.
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

/** Every quoted run in a file — the places a class list is written in JS/TS. */
function classSegments(context) {
  const sourceCode = context.sourceCode ?? context.getSourceCode();
  const segments = [];
  for (const token of sourceCode.getTokens(sourceCode.ast)) {
    if (token.type === "String" || token.type === "Template") {
      // A template is one token per quasi plus the substitutions between them;
      // the quasi is what carries the class names, and reading the whole token
      // would splice `${…}` expressions into the middle of a class list.
      segments.push(token);
    }
  }
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
    // Longest first: `blue-ink` has to win over `blue`, or the check would
    // report the `-ink` half of a name that exists.
    const byLength = [...colours].sort((a, b) => b.length - a.length);
    const prefixes = COLOUR_UTILITIES.join("|");
    const pattern = new RegExp(`(?<![\\w-])(?:${prefixes})-kin-([a-z0-9-]+)`, "g");
    return {
      Program() {
        for (const segment of classSegments(context)) {
          for (const [match, name] of segment.value.matchAll(pattern)) {
            if (byLength.some((colour) => name === colour || name.startsWith(`${colour}-`))) {
              continue;
            }
            context.report({ node: segment, messageId: "undefined", data: { name: match } });
          }
        }
      },
    };
  },
};

/** Refuse an arbitrary value on an axis the ladder has a word for. */
const noArbitraryLiteral = {
  meta: {
    type: "problem",
    docs: {
      description: "no arbitrary value on a ladder that has a word for every value in the tree",
    },
    schema: [],
    messages: { offLadder: "{{value}} — {{reason}}." },
  },
  create(context) {
    return {
      Program() {
        for (const segment of classSegments(context)) {
          for (const { pattern, message } of OFF_LADDER) {
            pattern.lastIndex = 0;
            for (const [value] of segment.value.matchAll(pattern)) {
              context.report({
                node: segment,
                messageId: "offLadder",
                data: { value, reason: message },
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
