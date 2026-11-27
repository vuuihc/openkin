/**
 * KIN-MOBILE-001 — the RN parity contract's signature, asserted where the mandate keeps it.
 *
 * `scripts/stories.py` refuses a story in `approved` with no test that names it, but the
 * behaviour tests this story's acceptance table promises under `mobile-rn/` are created by
 * R1–R7, which have not landed. So this file pins the half that is true today:
 *
 * - the contract and its registry row both say `approved`;
 * - `rsi/DECISIONS.md` carries the 2026-11-24 CEO call that names this story (MANDATE: a story
 *   is signed on the owner's behalf only when the call is recorded there);
 * - ADR 0036 fixes the layout, the in-place import rule, the two adapters, the dependency pins
 *   and the light gate — the parts the implementation is measured against;
 * - every shared module the ADR calls importable really is DOM-free, while the i18n module it
 *   aliases really does touch the DOM (otherwise the adapter is unjustified);
 * - the review page's frames are on disk, and the acceptance table names exactly the planned
 *   test files R1–R7 must add.
 *
 * DOM-free: `node:fs` plus this file's own location, no cwd, no React.
 */
import { existsSync, readFileSync } from "node:fs";
import { describe, expect, it } from "vitest";

const root = new URL("../../../", import.meta.url);
const read = (rel: string) => readFileSync(new URL(rel, root), "utf8");

const story = read("docs/product/stories/KIN-MOBILE-001.md");
const review = read("docs/product/stories/KIN-MOBILE-001.review.html");
const adr = read("docs/adr/0036-rn-client-layout-shared-ts-and-light-gate.md");
const decisions = read("rsi/DECISIONS.md");
const registry = JSON.parse(read("docs/product/stories/registry.json")) as {
  stories: { id: string; state: string }[];
};

/** The one recorded call that signs this story, or "" when there is none. */
function signCall(log: string): string {
  return (
    log
      .split("\n")
      .find(
        (line) => line.startsWith("- ") && line.includes("KIN-MOBILE-001") && line.includes("CEO"),
      ) ?? ""
  );
}

/** The ADR's dependency table rows: package, exact version, publish date. */
function dependencyRows(text: string) {
  return [...text.matchAll(/^\| `([^`]+)` \| `([^`]+)` \| (\d{4}-\d{2}-\d{2}) \|/gm)].map((m) => ({
    pkg: m[1],
    version: m[2],
    published: m[3],
  }));
}

/** The planned test files the acceptance table names, of any runner. */
function acceptanceTests(text: string): string[] {
  const table = text.slice(text.indexOf("## 验收"), text.indexOf("## 证据"));
  const paths = [...table.matchAll(/`((?:ui\/src|mobile-rn)\/[^`]+)`/g)].map((m) => m[1]);
  return [...new Set(paths.filter((p) => /\.(test|dom\.test)\.(ts|tsx)$/.test(p)))].sort();
}

describe("KIN-MOBILE-001 signature", () => {
  it("records the signed state", () => {
    // `approved` → `covered` is the story's own documented delivery step, so the reachable
    // signed states are asserted as a set rather than pinning the pre-delivery one.
    const signed = ["approved", "covered", "failing"];
    const storyState = story.match(/^状态：(.+)$/m)?.[1];
    const registryState = registry.stories.find((s) => s.id === "KIN-MOBILE-001")?.state;
    expect(storyState, "the contract records no 状态 line").toBeDefined();
    expect(signed, `contract state ${storyState}`).toContain(storyState);
    expect(signed, `registry state ${registryState}`).toContain(registryState);
    expect(registryState, "the contract and the registry disagree").toBe(storyState);
  });

  it("records the CEO call", () => {
    const call = signCall(decisions);
    expect(call, "rsi/DECISIONS.md carries no CEO call for KIN-MOBILE-001").not.toBe("");
    // The call has to be the one that authorises this shape, not a sentence that merely names
    // the story: the layout, the ADR and the dependency waiver are what a signer is agreeing to.
    expect(call).toContain("ADR 0036");
    expect(call).toContain("mobile-rn/");
    expect(call).toContain("light gate");
  });

  it("fixes the layout, the gate job and the four parity faces in ADR 0036", () => {
    expect(adr).toContain("Accepted (owner delegation, 2026-11-24)");
    expect(adr).toContain("`mobile-rn/`");
    expect(adr).toContain("`mobile-rn` job");
    expect(adr).toContain("`rsi/runtime/merge.sh:752-753`");
    for (const face of [
      "conversation list",
      "conversation read/send/stream/interrupt",
      "approvals and questions",
      "provider/usage sheets",
    ]) {
      expect(adr, `ADR 0036 does not name the ${face} face`).toContain(face);
    }
  });

  it("pins every dependency exactly and at least seven days old", () => {
    const rows = dependencyRows(adr);
    expect(rows.length, "the ADR dependency table is missing or unparsed").toBe(19);
    expect(new Set(rows.map((r) => r.pkg))).toEqual(
      new Set([
        "expo",
        "expo-router",
        "react-native",
        "react",
        "react-native-screens",
        "react-native-safe-area-context",
        "expo-linking",
        "expo-constants",
        "expo-status-bar",
        "expo-secure-store",
        "expo-notifications",
        "expo-blur",
        "expo-haptics",
        "expo-symbols",
        "expo-glass-effect",
        "jest-expo",
        "typescript",
        "@types/react",
        "@testing-library/react-native",
      ]),
    );
    for (const row of rows) {
      // No `^`, no `~`, no dist-tag: an exact pin is three numbers.
      expect(row.version, `${row.pkg} is not an exact pin`).toMatch(/^\d+\.\d+\.\d+$/);
      // 2026-11-24 minus seven days. A pin newer than that has not survived a week in public.
      expect(row.published <= "2026-11-17", `${row.pkg}@${row.version} is too new`).toBe(true);
    }
    const ui = JSON.parse(read("ui/package.json")) as {
      dependencies?: Record<string, string>;
      devDependencies?: Record<string, string>;
    };
    const uiDeps = { ...(ui.dependencies ?? {}), ...(ui.devDependencies ?? {}) };
    for (const pkg of ["expo", "expo-router", "react-native", "expo-secure-store"]) {
      expect(uiDeps, `${pkg} leaked into ui/package.json`).not.toHaveProperty(pkg);
    }
  });

  it("every version in the RN manifest matches its ADR row", () => {
    // The table is the signature; the manifest is what Metro installs. Nothing else compares
    // them, so a package edited in one place and not the other would ship a version the ADR
    // never signed. One direction only: the ADR also lists a parked package
    // (`expo-notifications`, row 53) that is deliberately absent from the manifest.
    const manifest = JSON.parse(read("mobile-rn/package.json")) as {
      dependencies?: Record<string, string>;
      devDependencies?: Record<string, string>;
    };
    const pinned = { ...(manifest.dependencies ?? {}), ...(manifest.devDependencies ?? {}) };
    const rows = dependencyRows(adr);
    for (const row of rows) {
      if (!(row.pkg in pinned)) continue;
      expect(pinned[row.pkg], `${row.pkg} disagrees with its ADR row`).toBe(row.version);
    }
    // R5's three Expo packages: pinned here and recorded in the ADR in the same change.
    for (const pkg of ["expo-haptics", "expo-symbols", "expo-glass-effect"]) {
      expect(pinned, `${pkg} is not pinned in mobile-rn/package.json`).toHaveProperty(pkg);
      expect(
        rows.map((r) => r.pkg),
        `the ADR has no ${pkg} row`,
      ).toContain(pkg);
    }
  });

  it("names two adapters and proves the shared modules it calls importable are DOM-free", () => {
    expect(adr).toContain("mobile-rn/src/i18n.ts");
    expect(adr).toContain("mobile-rn/src/api/transport.ts");
    expect(adr).toContain("A second copy of shared logic is a defect");

    // A DOM *use* is an identifier after the dot; prose like "the loaded window. Its events"
    // does not count, which is why the pattern is not a bare `window.` grep.
    const DOM_USE = /\b(?:window|document|localStorage|sessionStorage)\.[A-Za-z_$]/;
    for (const rel of [
      "ui/src/api/contract.ts",
      "ui/src/api/generated/openapi.ts",
      "ui/src/i18n/locales/en.ts",
      "ui/src/i18n/locales/zh.ts",
      "ui/src/components/chat/transcriptProjection.ts",
    ]) {
      const text = read(rel);
      const offending = text
        .split("\n")
        .map((line, index) => ({ line, index: index + 1 }))
        .filter(({ line }) => DOM_USE.test(line));
      expect(offending, `${rel}:${offending[0]?.index ?? 0} uses the DOM`).toEqual([]);
      expect(text, `${rel} imports react-dom`).not.toMatch(/["']react-dom["']/);
    }

    // The i18n adapter is not decoration: the module Metro aliases does touch the DOM today.
    const i18nIndex = read("ui/src/i18n/index.ts");
    expect(i18nIndex).toMatch(/\blocalStorage\.getItem/);
    expect(i18nIndex).toMatch(/\bwindow\.dispatchEvent/);
  });

  it("names exactly the acceptance test files the seven slices must add", () => {
    expect(acceptanceTests(story)).toEqual([
      "mobile-rn/src/auth/pairing.test.ts",
      "mobile-rn/src/gate/checkJob.test.ts",
      "mobile-rn/src/native/reconnect.test.ts",
      "mobile-rn/src/screens/Approvals.test.tsx",
      "mobile-rn/src/screens/Conversation.test.tsx",
      "mobile-rn/src/screens/ConversationList.test.tsx",
      "mobile-rn/src/screens/ProviderUsage.test.tsx",
      "mobile-rn/src/shared/importContract.test.ts",
      "ui/src/lib/surfacesContract.KIN-MOBILE-001.test.ts",
    ]);
  });

  it("keeps the seven slices in the same order in the ADR and the story", () => {
    const adrSlices = [...adr.matchAll(/^\| (R[1-7]) \|/gm)].map((m) => m[1]);
    expect(adrSlices).toEqual(["R1", "R2", "R3", "R4", "R5", "R6", "R7"]);
    for (const slice of adrSlices) {
      expect(story, `the story has no ${slice} acceptance row`).toContain(`| ${slice} `);
    }
  });

  it("ships its Figma-first review page, every referenced frame on disk", () => {
    expect(review).toContain('<meta name="kin-review-format" content="figma-flow-v1">');
    expect(review).toContain("用户流程");
    expect(review).toContain("width=device-width");
    expect(review).toContain("<h2>MECE");
    expect(review).not.toContain("（填）");
    // No CDN: frames, styles and copy are local. An external image or script on the page that
    // signed the story would make the artifact depend on something the repository cannot keep.
    expect(review).not.toMatch(/<(?:script|img|link)[^>]+(?:src|href)="https?:\/\//i);

    const frames = [
      ...new Set(
        [...review.matchAll(/KIN-[A-Z]+-\d{3}\.figma\/frames\/[^"'\s>]+\.svg/g)].map((m) => m[0]),
      ),
    ];
    expect(frames.length, "the review page references no frames").toBeGreaterThan(0);
    for (const frame of frames) {
      expect(
        existsSync(new URL(`docs/product/stories/${frame}`, root)),
        `${frame} is referenced by the review page but is missing on disk`,
      ).toBe(true);
    }
  });
});
