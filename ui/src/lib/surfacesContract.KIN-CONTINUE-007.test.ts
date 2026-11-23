/**
 * KIN-CONTINUE-007 — the 820 list-scan contract's signature, asserted where the mandate keeps it.
 *
 * Why this exists before the list changes: `scripts/stories.py` refuses a story in
 * `approved` with no test that names it, and the behaviour tests this story's
 * acceptance table promises (`SessionList.listScan.dom.test.tsx`,
 * `SessionRow.coarse.dom.test.tsx`, `sessionListFolds.test.ts`) are written by the
 * implementation that has not landed yet. So this file pins the half that is true
 * today — that the signature itself is recorded, and in the place the loop's
 * mandate names (`rsi/MANDATE.md`: a story is signed on the owner's behalf **only**
 * when the call is recorded in `rsi/DECISIONS.md`):
 *
 * - the story and its registry row both say `approved` (one half cannot drift);
 * - `rsi/DECISIONS.md` carries the CEO call that names this story;
 * - every decision the review page still asks a person to answer (its reply
 *   template's `D<n> 同意` lines) is named by that recorded call — add a D7 to the
 *   page without recording a call and this goes red.
 *
 * The bounds the signature fixes are asserted where a reader can see them: the
 * 820×1180 / ≥10 rows contract in the story, and the 1023.98px coarse-pointer
 * bound of D4 (AGENTS.md rule 16). DOM-free: `node:fs` plus this file's own
 * location, no cwd, no React.
 */
import { readFileSync } from "node:fs";
import { describe, expect, it } from "vitest";

const root = new URL("../../../", import.meta.url);
const read = (rel: string) => readFileSync(new URL(rel, root), "utf8");

const story = read("docs/product/stories/KIN-CONTINUE-007.md");
const review = read("docs/product/stories/KIN-CONTINUE-007.review.html");
const decisions = read("rsi/DECISIONS.md");
const registry = JSON.parse(read("docs/product/stories/registry.json")) as {
  stories: { id: string; state: string }[];
};

/** The review page's reply template, i.e. the decisions it still asks a person to answer. */
function openDecisions(page: string): string[] {
  const reply = page
    .slice(page.lastIndexOf("<pre>"), page.lastIndexOf("</pre>"))
    // The first line follows `<pre>` on the same source line, so it needs its own break.
    .replace("<pre>", "<pre>\n");
  return [...reply.matchAll(/^(D\d+) 同意$/gm)].map((m) => m[1]);
}

/** The one recorded call that signs this story, or "" when there is none. */
function signCall(log: string): string {
  return (
    log
      .split("\n")
      .find((line) => line.startsWith("- ") && line.includes("CEO signs `KIN-CONTINUE-007`")) ?? ""
  );
}

describe("KIN-CONTINUE-007 signature", () => {
  it("records the story as approved in both the contract and the registry", () => {
    expect(story).toMatch(/^状态：approved$/m);
    expect(registry.stories.find((s) => s.id === "KIN-CONTINUE-007")?.state).toBe("approved");
  });

  it("records the CEO call in rsi/DECISIONS.md, as the mandate requires", () => {
    expect(
      signCall(decisions),
      "rsi/DECISIONS.md carries no CEO call for KIN-CONTINUE-007",
    ).not.toBe("");
  });

  it("names every decision the review page still asks a person to answer", () => {
    const asked = openDecisions(review);
    // Three open decisions (D4–D6); D1–D3 are already settled upstream and are not in the template.
    expect(asked).toEqual(["D4", "D5", "D6"]);
    const call = signCall(decisions);
    for (const id of asked) {
      expect(
        call,
        `${id} is asked on the review page but not named in the recorded call`,
      ).toContain(id);
    }
  });

  it("names exactly the four acceptance test files the implementation must add", () => {
    // The 验收 table is the contract the implementation is measured against; a renamed or
    // dropped row would otherwise let the delivery choose its own proof.
    const table = story.slice(story.indexOf("## 验收"), story.indexOf("## 证据"));
    const named = [...table.matchAll(/\|.*?`(ui\/src\/[^`]+)`/g)]
      .map((m) => m[1])
      .filter((p) => /\.(test|dom\.test)\.(ts|tsx)$/.test(p));
    expect([...new Set(named)].sort()).toEqual([
      "ui/src/components/layout/Sidebar.dom.test.tsx",
      "ui/src/components/sessions/SessionList.listScan.dom.test.tsx",
      "ui/src/components/sessions/SessionRow.coarse.dom.test.tsx",
      "ui/src/lib/sessionListFolds.test.ts",
    ]);
  });

  it("keeps the bounds the signature fixes where the implementation reads them", () => {
    // The acceptance number, not a mood: one 820 screenful shows ten complete rows.
    expect(story).toContain("一屏至少 10 条对话行完整可见");
    // D4: the coarse-pointer arm runs to 1023.98px, never a width breakpoint (AGENTS.md 16).
    expect(story).toContain("1023.98");
    expect(story).toContain("pointer: coarse");
  });
});
