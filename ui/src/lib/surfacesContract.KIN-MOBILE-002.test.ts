/**
 * KIN-MOBILE-002 — the RN visual-system story's signature guard.
 *
 * The behaviour and visual tests in the acceptance table are created by the implementation
 * slices themselves. Until then this file pins the half that must already be true: the story
 * and registry agree on `approved`, the CEO call is recorded, the Figma-first review page is
 * complete and local, the risky LAN-http decision carries its safeguards, and the dependency
 * decision names the ADR update the first implementation PR owes.
 */
import { existsSync, readFileSync } from "node:fs";
import { describe, expect, it } from "vitest";

const root = new URL("../../../", import.meta.url);
const read = (rel: string) => readFileSync(new URL(rel, root), "utf8");

const story = read("docs/product/stories/KIN-MOBILE-002.md");
const review = read("docs/product/stories/KIN-MOBILE-002.review.html");
const decisions = read("rsi/DECISIONS.md");
const registry = JSON.parse(read("docs/product/stories/registry.json")) as {
  stories: { id: string; state: string; tests?: string[] }[];
};

function acceptanceTests(text: string): string[] {
  const table = text.slice(text.indexOf("## 验收"), text.indexOf("## 证据"));
  const paths = [...table.matchAll(/`((?:mobile-rn|ui\/src)\/[^`]+)`/g)].map((m) => m[1]);
  return [...new Set(paths.filter((p) => /\.(test|dom\.test)\.(ts|tsx)$/.test(p)))].sort();
}

describe("KIN-MOBILE-002 signature", () => {
  it("records the signed state in the story and the registry", () => {
    const storyState = story.match(/^状态：(.+)$/m)?.[1];
    const row = registry.stories.find((s) => s.id === "KIN-MOBILE-002");
    expect(storyState).toBe("approved");
    expect(row?.state).toBe("approved");
    expect(row?.tests).toContain("ui/src/lib/surfacesContract.KIN-MOBILE-002.test.ts");
  });

  it("records the CEO call with the D3 and D5 safeguards", () => {
    const call =
      decisions
        .split("\n")
        .find(
          (line) =>
            line.startsWith("- ") &&
            line.includes("CEO 受托签字 KIN-MOBILE-002") &&
            line.includes("approved"),
        ) ?? "";
    expect(call).not.toBe("");
    expect(call).toContain("凭据明文传输");
    expect(call).toContain("地址变化重新确认");
    expect(call).toContain("ADR 0036");
  });

  it("pins the LAN-http confirmation contract the advisor called the largest risk", () => {
    for (const text of [story, review]) {
      expect(text).toContain("凭据明文");
      expect(text).toContain("地址变化重新确认");
    }
    expect(story).toContain("Given 拒绝 Then 不连接且不记住确认");
    expect(story).toContain("Given 同一 origin 已确认 When 重连 Then 不重复询问");
  });

  it("pins the three Expo dependency decision and its ADR follow-through", () => {
    for (const pkg of ["expo-haptics", "expo-symbols", "expo-glass-effect"]) {
      expect(story).toContain(pkg);
      expect(review).toContain(pkg);
    }
    expect(story).toContain("同步更新 ADR 0036 的依赖表与签名测试");
    expect(review).toContain("ADR 0036 要加一行");
  });

  it("names exactly the planned acceptance test files", () => {
    expect(acceptanceTests(story)).toEqual([
      "mobile-rn/src/screens/Approvals.visual.test.tsx",
      "mobile-rn/src/screens/Conversation.visual.test.tsx",
      "mobile-rn/src/screens/ConversationList.visual.test.tsx",
      "mobile-rn/src/screens/pair.visual.test.tsx",
      "mobile-rn/src/theme/noLiterals.test.ts",
      "mobile-rn/src/theme/theme.test.ts",
      "mobile-rn/src/theme/tokens.parity.test.ts",
    ]);
  });

  it("ships a local Figma-first review page and every frame it references", () => {
    expect(review).toContain('<meta name="kin-review-format" content="figma-flow-v1">');
    expect(review).toContain("用户流程");
    expect(review).toContain("width=device-width");
    expect(review).toContain("<h2>MECE");
    expect(review).not.toContain("（填）");
    expect(review).not.toMatch(/<(?:script|img|link)[^>]+(?:src|href)="https?:\/\//i);

    const frames = [
      ...new Set(
        [...review.matchAll(/KIN-MOBILE-002\.figma\/frames\/[^"'\s>]+\.svg/g)].map((m) => m[0]),
      ),
    ].sort();
    expect(frames).toEqual([
      "KIN-MOBILE-002.figma/frames/01-phone-pair.svg",
      "KIN-MOBILE-002.figma/frames/02-phone-list.svg",
      "KIN-MOBILE-002.figma/frames/03-phone-conversation.svg",
      "KIN-MOBILE-002.figma/frames/04-phone-composer-approval.svg",
      "KIN-MOBILE-002.figma/frames/05-phone-usage-sheet.svg",
      "KIN-MOBILE-002.figma/frames/06-phone-states.svg",
    ]);
    for (const frame of frames) {
      expect(existsSync(new URL(`docs/product/stories/${frame}`, root)), frame).toBe(true);
    }
  });
});
