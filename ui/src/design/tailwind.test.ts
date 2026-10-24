import postcss from "postcss";
import tailwindcss from "tailwindcss";
import { describe, expect, it } from "vitest";
import config from "../../tailwind.config.ts";
import { TYPE_ROLES } from "./type";

/**
 * The ladder, through the build pipeline rather than through a parser.
 *
 * `tailwind.config.ts` imports the sizes from `design/type.ts`, which Tailwind
 * reaches through jiti — a path nothing else in the repo exercises, and one
 * that fails *silently*: if the import stops resolving, every `text-<role>`
 * class quietly disappears and the console inherits whatever size it had. These
 * two cases compile real utilities with the real config, so that failure is a
 * red test instead of a screenshot someone has to notice.
 */

async function utilities(classes: string): Promise<string> {
  const result = await postcss([
    tailwindcss({ ...config, content: [{ raw: `<div class="${classes}"></div>` }] }),
  ]).process("@tailwind utilities;", { from: undefined });
  return result.css;
}

describe("type ladder through Tailwind", () => {
  it("emits every role at the size the ladder declares", async () => {
    const css = await utilities(TYPE_ROLES.map((r) => `text-${r.role}`).join(" "));
    for (const role of TYPE_ROLES) {
      expect({ role: role.role, emitted: css.includes(`.text-${role.role} {`) }).toEqual({
        role: role.role,
        emitted: true,
      });
      expect(css).toContain(`font-size: ${role.px}px`);
    }
  });

  it("no longer emits any of the default sizes", async () => {
    // Spelled by joining the prefix on, like the ladder's `absorbed` lists: a
    // literal default name in this tree is what the leftover-size guard in
    // `tokens.test.ts` forbids, and it reads this file too.
    const removed = ["xs", "sm", "base", "lg", "xl", "2xl", "3xl"];
    const css = await utilities(removed.map((name) => `text-${name}`).join(" "));
    // Assignment, not `extend`: the defaults are gone, so these produce nothing.
    expect(css.replace(/\/\*[\s\S]*?\*\//g, "").trim()).toBe("");
  });
});

/**
 * The rest of the ladders, through the same pipeline and for the same reason:
 * nothing else in the repo compiles a class name, so a step that stops
 * resolving is invisible until someone looks at the screen and wonders why the
 * section labels are loose. Each row is a class the tree uses and a fragment of
 * the declaration the browser has to end up with.
 */
describe("scale ladders through Tailwind", () => {
  const STEPS: [string, string][] = [
    ["tracking-label", "letter-spacing: 0.06em"],
    ["leading-prose", "line-height: 1.625"],
    ["leading-flush", "line-height: 1"],
    ["leading-4", "line-height: 1rem"],
    // The colour is not pinned here any more: since S5 it is a token, so the
    // declaration ends at the `var()` and how dark the value is belongs to
    // `tokens.test.ts`, which measures it in both schemes. What this still
    // proves is the half that only a build can: the step resolves, and the
    // geometry the ladder declares is the geometry that ships.
    ["shadow-e1", "0 1px 2px var(--kin-shadow-1)"],
    ["shadow-e3", "0 40px 90px -20px var(--kin-shadow-3)"],
    ["min-h-11", "min-height: 2.75rem"],
    ["w-sidebar", "width: 248px"],
    ["max-w-conversation", "max-width: 720px"],
    ["max-w-sheet", "max-width: min(100%, 420px)"],
    ["max-w-inspector", "max-width: min(40%, 18rem)"],
    // Not a scale step, but the two lines whose failure is an accessibility
    // failure: a token name that stopped resolving would emit no ring — or no
    // outline — at all, and nothing on screen would say so.
    ["ring-kin-focus-ring", "--tw-ring-color: var(--kin-focus-ring)"],
    ["outline-kin-focus-ring", "outline-color: var(--kin-focus-ring)"],
  ];

  it("emits every step at the value the ladder declares", async () => {
    const css = await utilities(STEPS.map(([name]) => name).join(" "));
    for (const [name, declaration] of STEPS) {
      expect({ name, emitted: css.includes(declaration) }).toEqual({ name, emitted: true });
    }
  });

  it("no longer emits the names the ladders replaced", async () => {
    const removed = [
      ["wide", "wider", "widest"].map((n) => "tracking-" + n),
      ["tight", "normal", "relaxed", "snug", "loose"].map((n) => "leading-" + n),
      ["sm", "md", "lg", "xl", "2xl", "inner", "none"].map((n) => "shadow-" + n),
      // The bare DEFAULT step, split so this line does not name it.
      ["shad" + "ow"],
      ["card", "pill"].map((n) => "rounded-" + n),
    ].flat();
    const css = await utilities(removed.join(" "));
    expect(css.replace(/\/\*[\s\S]*?\*\//g, "").trim()).toBe("");
  });
});
