/**
 * The navigation contract as prose, checked against the code's own tables.
 *
 * `NAVIGATION.md` is the document a person reads before adding a surface, and
 * it went stale once already: it kept describing the 2026-11-12 phone-only
 * model after the console had shipped four areas, a Mac rail and per-area
 * stacks. Wrong contract docs are why a slice can rebuild navigation that was
 * deliberately deleted.
 *
 * So the parts of the document that are *contract* — every area, every route,
 * the arrival kinds, the phone entries — are asserted here instead of trusted
 * to review. Prose stays free: this test names literals and relationships, not
 * sentences, so a rewrite that improves wording stays green.
 *
 * DOM-free on purpose: the suite's default environment is Node, the two
 * tables import without React, and a docs check has no reason to pay for a
 * document. `node:fs` + `import.meta.url` resolves the docs from this file's
 * own location, so the test does not depend on the process's cwd.
 */
import { readFileSync } from "node:fs";
import { describe, expect, it } from "vitest";
import type { TransitionKind } from "./areaTransition";
import { AREAS } from "./areas";
import { PHONE_TAB_IDS } from "./phoneNavigation";

function doc(name: string): string {
  return readFileSync(new URL(`../../../docs/product/${name}`, import.meta.url), "utf8");
}

const navigation = doc("NAVIGATION.md");
const ia = doc("IA.md");
const appSource = readFileSync(new URL("../App.tsx", import.meta.url), "utf8");

describe("navigation contract", () => {
  it("NAVIGATION.md has the area table row and the phone-entry line", () => {
    // Shape, not substring: dropping a row from §1 must fail even though the id
    // still appears somewhere else in the prose.
    for (const area of AREAS) {
      expect(navigation).toMatch(
        new RegExp("\\|\\s*`" + area.id + "`\\s*\\|\\s*`" + area.root + "`"),
      );
    }
    const entries = "`PHONE_TAB_IDS` = " + PHONE_TAB_IDS.map((id) => `\`${id}\``).join(" / ");
    expect(navigation).toContain(entries);
  });

  it("NAVIGATION.md has a table row for every route App owns", () => {
    // Read the routes out of the router itself: a hand-copied array stays green
    // when a route is added or removed, which is exactly the rot this guards.
    const routes = [...appSource.matchAll(/<Route\s+path="([^"]+)"/g)].map((match) => match[1]);
    expect(routes.length).toBeGreaterThan(0);
    for (const route of routes) {
      expect(navigation).toContain(`\`${route}\``);
    }
  });

  it("the superseded one-list-page phone model is gone", () => {
    expect(navigation).not.toContain("手机只有一个导航面");
    expect(navigation).not.toContain("没有 tab");
    expect(navigation).toContain("四个区域");
    expect(navigation).toContain("Agent Ops");
  });

  it("the motion contract has a table row for every arrival kind and reduced motion", () => {
    // Row shape again: deleting the whole §4 table used to leave every kind
    // alive in the summary bullets below it.
    const kinds: readonly TransitionKind[] = ["none", "area", "push", "pop", "swap"];
    for (const kind of kinds) {
      expect(navigation).toMatch(new RegExp("\\|\\s*`" + kind + "`\\s*\\|"));
    }
    expect(navigation).toContain("减少动态");
    // The reduced-motion sentence promises the fade alone, with no travel.
    expect(navigation).toMatch(/减少动态[^。\n]*淡入/);
  });

  it("IA.md keeps D8's four phone entries and the projects area root", () => {
    for (const phrase of ["对话列表", "例行任务", "Agent 运维", "设置", "D8", "/projects"]) {
      expect(ia).toContain(phrase);
    }
  });
});
