import { readFileSync } from "node:fs";
import { join } from "node:path";
import { fileURLToPath } from "node:url";
import { describe, expect, it } from "vitest";

/**
 * The keyboard legends are hidden on a phone, and this is what "hidden" means.
 *
 * The session view teaches `A` / `D` and the composer teaches `⌘↵`. None of
 * those keys exists on a phone, so on a phone the legend is a caption for a
 * missing button — but the same strings are the *only* hint a desktop user gets,
 * so the fix cannot be deletion. Every site is gated below `sm` instead, which
 * is a two-part claim: `hidden` on its own would take the hint away from the
 * desktop too, and a `sm:` display class without `hidden` would never apply.
 * Both halves are asserted, per site.
 *
 * Source rather than DOM, like `zen.test.ts` and `PanelSurface.test.ts`: the tree
 * has no DOM test environment by design, and "this element carries these two
 * classes" is a property of the source text. Measured in the browser as well
 * (390px: no visible `<kbd>`, buttons read 批准 / 拒绝; 700px: A and D back), but
 * that measurement is state-dependent — it needs a session that is actually
 * waiting on something — so the guard lives here.
 */
const UI = fileURLToPath(new URL("../..", import.meta.url));

const read = (rel: string) => readFileSync(join(UI, rel), "utf8");

/** The class list of the last `<tag className="…">` before `needle`. */
function classesBefore(source: string, needle: string, tag: string): string {
  const at = source.indexOf(needle);
  if (at === -1) return "";
  const re = new RegExp(`<${tag} className="([^"]*)"`, "g");
  const all = [...source.slice(0, at).matchAll(re)];
  return all[all.length - 1]?.[1] ?? "";
}

/** Both halves of the gate, in either order. */
function gated(classes: string): { hidden: boolean; restored: boolean } {
  const tokens = classes.split(/\s+/);
  return {
    hidden: tokens.includes("hidden"),
    restored: tokens.some((t) => /^sm:(block|inline|inline-flex|flex)$/.test(t)),
  };
}

describe("keyboard legends on a phone", () => {
  it("hides the session view's A/D legend below sm, and keeps it above", () => {
    const source = read("src/pages/TaskDetailPage.tsx");
    // The `<p>` itself, not the `<kbd>` inside it — those carry borders, not
    // gates, and picking up the wrong element is the way this test would pass
    // while the legend stayed on screen.
    const classes = classesBefore(source, "question.hintKeys", "p");
    expect(classes).not.toBe("");
    expect(gated(classes)).toEqual({ hidden: true, restored: true });
  });

  it("hides the key letters inside the approval buttons below sm", () => {
    const source = read("src/components/cards/ApprovalCard.tsx");
    const spans = [...source.matchAll(/<span className="([^"]*)">([AD])<\/span>/g)].map((m) => ({
      classes: m[1] ?? "",
      letter: m[2] ?? "",
    }));
    // Both buttons, or this guard is watching half of the pair.
    expect(spans.map((s) => s.letter).sort()).toEqual(["A", "D"]);
    for (const span of spans) {
      expect({ letter: span.letter, ...gated(span.classes) }).toEqual({
        letter: span.letter,
        hidden: true,
        restored: true,
      });
    }
  });

  it("keeps the composer's legends on the card's width, not the viewport", () => {
    // The composer's ⌘↵ legend was where this pattern came from, but its gate
    // moved from the viewport (`sm`) to the card (`@xl`): an iPad in portrait
    // draws a 344–396px card inside the desktop shell at 768–820, and there
    // both legends cost the run-config face more than the row could spare.
    // `@` follows the same cut — the legends are one desktop affordance, and
    // the placeholder still names delegation when the card is narrow. The
    // approval letters keep their viewport gate: they are drawn inside a card
    // that is the full phone width.
    const composer = read("src/components/chat/Composer.tsx");
    expect(composer).toMatch(/hidden @xl:inline-flex/);
    expect(composer).not.toMatch(/hidden sm:inline-flex/);
    const atLegend = composer.slice(
      Math.max(0, composer.indexOf('"composer.agent"') - 480),
      composer.indexOf('"composer.agent"'),
    );
    expect(atLegend).toMatch(/@xl:inline-flex/);
    expect(atLegend).not.toMatch(/sm:(block|inline|inline-flex|flex)/);
  });
});
