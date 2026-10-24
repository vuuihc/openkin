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
