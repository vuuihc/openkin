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
import { AREAS } from "./areas";
import { PHONE_TAB_IDS } from "./phoneNavigation";

function doc(name: string): string {
  return readFileSync(new URL(`../../../docs/product/${name}`, import.meta.url), "utf8");
}

const navigation = doc("NAVIGATION.md");
const ia = doc("IA.md");

describe("navigation contract", () => {
  it("NAVIGATION.md names every area, its root and every phone entry", () => {
    for (const area of AREAS) {
      expect(navigation).toContain(area.id);
      expect(navigation).toContain(area.root);
    }
    for (const id of PHONE_TAB_IDS) {
      expect(navigation).toContain(id);
    }
  });

  it("NAVIGATION.md lists every route App owns", () => {
    const routes = [
      "/sessions",
      "/tasks/:id",
      "/new",
      "/projects",
      "/projects/:id",
      "/routines",
      "/machines/:device/tasks/:id",
      "/settings",
      "/agent-sessions/:id",
      "/agents",
      "/usage",
      "/inbox",
      "/approvals",
    ];
    for (const route of routes) {
      expect(navigation).toContain(route);
    }
  });

  it("the superseded one-list-page phone model is gone", () => {
    expect(navigation).not.toContain("手机只有一个导航面");
    expect(navigation).not.toContain("没有 tab");
    expect(navigation).toContain("四个区域");
    expect(navigation).toContain("Agent Ops");
  });

  it("the motion contract names every arrival kind and reduced motion", () => {
    for (const kind of ["area", "push", "pop", "swap"]) {
      expect(navigation).toContain(kind);
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
