/**
 * KIN-MOBILE-002 — the RN visual-system story's signature guard.
 *
 * `scripts/stories.py` refuses a story in `approved` with no test that names it, but the
 * visual acceptance tests this story's table promises under `mobile-rn/` are created by
 * R1–R6, which have not landed. So this file pins the half that is true today:
 *
 * - the contract and its registry row both say a signed state;
 * - `rsi/DECISIONS.md` carries the 2026-11-27 owner sign-off and the rule that visual-tier
 *   decisions are the CEO's call from that date on;
 * - the review page carries the figma-flow-v1 marker, the frames it references are on disk,
 *   and `mobile-rn/DESIGN.md` exists as the durable design document;
 * - the acceptance table names exactly the planned test files R1–R6 must add.
 *
 * DOM-free: `node:fs` plus this file's own location, no cwd, no React.
 */
import { existsSync, readFileSync } from "node:fs";
import { describe, expect, it } from "vitest";

const root = new URL("../../../", import.meta.url);
const read = (rel: string) => readFileSync(new URL(rel, root), "utf8");

const story = read("docs/product/stories/KIN-MOBILE-002.md");
const review = read("docs/product/stories/KIN-MOBILE-002.review.html");
const decisions = read("rsi/DECISIONS.md");
const registry = JSON.parse(read("docs/product/stories/registry.json")) as {
  stories: { id: string; state: string }[];
};

/** The planned test files the acceptance table names. */
function acceptanceTests(text: string): string[] {
  const table = text.slice(text.indexOf("## 验收"), text.indexOf("## 证据"));
  const paths = [...table.matchAll(/`((?:ui\/src|mobile-rn)\/[^`]+)`/g)].map((m) => m[1]);
  return [...new Set(paths.filter((p) => /\.(test|dom\.test)\.(ts|tsx)$/.test(p)))].sort();
}

describe("KIN-MOBILE-002 signature", () => {
  it("records the signed state", () => {
    const signed = ["approved", "covered", "failing"];
    const storyState = story.match(/^状态：(.+)$/m)?.[1];
    const registryState = registry.stories.find((s) => s.id === "KIN-MOBILE-002")?.state;
    expect(storyState, "the contract records no 状态 line").toBeDefined();
    expect(signed, `contract state ${storyState}`).toContain(storyState);
    expect(signed, `registry state ${registryState}`).toContain(registryState);
    expect(registryState, "the contract and the registry disagree").toBe(storyState);
  });

  it("records the owner sign-off and the visual-tier rule", () => {
    const line = decisions
      .split("\n")
      .find((l) => l.startsWith("- ") && l.includes("KIN-MOBILE-002")) ?? "";
    expect(line, "rsi/DECISIONS.md carries no sign-off line for KIN-MOBILE-002").not.toBe("");
    expect(line).toContain("设计级决定");
    expect(line).toContain("CEO");
  });

  it("ships the frames the review page references, and the design doc", () => {
    expect(review).toContain('content="figma-flow-v1"');
    expect(review).toContain("用户流程");
    const frames = [...new Set([...review.matchAll(/KIN-MOBILE-002\.figma\/frames\/([\w.-]+\.svg)/g)].map((m) => m[1]))].sort();
    expect(frames.length, "the review page references no frames").toBeGreaterThanOrEqual(5);
    for (const frame of frames) {
      const rel = `docs/product/stories/KIN-MOBILE-002.figma/frames/${frame}`;
      expect(existsSync(new URL(rel, root)), `${rel} is missing`).toBe(true);
    }
    expect(existsSync(new URL("mobile-rn/DESIGN.md", root)), "mobile-rn/DESIGN.md is missing").toBe(true);
  });

  it("names the planned acceptance tests", () => {
    const planned = acceptanceTests(story);
    expect(planned).toEqual([
      "mobile-rn/src/screens/Approvals.visual.test.tsx",
      "mobile-rn/src/screens/Conversation.visual.test.tsx",
      "mobile-rn/src/screens/ConversationList.visual.test.tsx",
      "mobile-rn/src/screens/pair.visual.test.tsx",
      "mobile-rn/src/theme/noLiterals.test.ts",
      "mobile-rn/src/theme/theme.test.ts",
      "mobile-rn/src/theme/tokens.parity.test.ts",
    ]);
  });
});
