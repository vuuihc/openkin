/**
 * The navigation contract as prose, checked against the code's own tables.
 *
 * `NAVIGATION.md` is the document a person reads before adding a surface, and
 * it went stale once already: it kept describing the 2026-11-12 phone-only
 * model after the console had shipped the area rail and per-area stacks. Wrong
 * contract docs are why a slice can rebuild navigation that was deliberately
 * deleted.
 *
 * So the parts of the document that are *contract* — every area, every route,
 * the arrival kinds, the phone entries — are asserted here instead of trusted
 * to review. Prose stays free: this test names literals and relationships, not
 * sentences, so a rewrite that improves wording stays green.
 *
 * The route table has a second half the doc cannot check on its own: a new page
 * used to ship by adding its `<Route>` and a §2 row in the same PR. The row was
 * both the thing being checked and the thing that licensed the change, so the
 * page and its documentation arrived together and every assertion stayed green.
 * §3 R8 says the opposite — a row missing from §2 must not ship — and the
 * allowlist below makes that literal: every route names the signed story that
 * ships it, and App's routes, the allowlist and §2's table are the same set.
 * A doc row alone cannot admit a route, and a route alone cannot ship
 * undocumented.
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

interface RegistryStory {
  readonly id: string;
  readonly state: string;
}

const registry = JSON.parse(
  readFileSync(new URL("../../../docs/product/stories/registry.json", import.meta.url), "utf8"),
) as { stories: readonly RegistryStory[] };

/** Only a story a person has signed may name a route. */
const SIGNED_STATES = new Set(["covered", "approved"]);

/**
 * Every route `App.tsx` may render, and the signed story that names it.
 *
 * KIN-CONTRACT-001 is the four-page contract that freezes or retires every
 * route here except `/routines`, whose page KIN-ROUTINE-001 owns. The values
 * are registry ids in `covered` / `approved` state, and that story's own file
 * must spell the URL: a route needs the story, the §2 row and this entry, and
 * no one of the three alone admits it.
 */
const ROUTE_ALLOWLIST: Record<string, string> = {
  "/": "KIN-CONTRACT-001",
  "/sessions": "KIN-CONTRACT-001",
  "/inbox": "KIN-CONTRACT-001",
  "/approvals": "KIN-CONTRACT-001",
  "/tasks/:id": "KIN-CONTRACT-001",
  "/new": "KIN-CONTRACT-001",
  "/agent-sessions/:id": "KIN-CONTRACT-001",
  "/projects": "KIN-CONTRACT-001",
  "/projects/:id": "KIN-CONTRACT-001",
  "/routines": "KIN-ROUTINE-001",
  "/machines/:device/tasks/:id": "KIN-CONTRACT-001",
  "/agents": "KIN-CONTRACT-001",
  "/usage": "KIN-CONTRACT-001",
  "/settings": "KIN-CONTRACT-001",
  "*": "KIN-CONTRACT-001",
};

function appRoutes(): string[] {
  return [...appSource.matchAll(/<Route\s+path="([^"]+)"/g)].map((match) => match[1]);
}

/**
 * §2 is the signed route table. Both bounds are asserted, so a renamed heading
 * fails here instead of silently slicing an empty string that compares equal
 * to nothing.
 */
function navigationRouteSection(): string {
  const start = navigation.indexOf("## 2.");
  const end = navigation.indexOf("## 3.");
  expect(start, "NAVIGATION.md must keep its §2 route table").toBeGreaterThanOrEqual(0);
  expect(end, "NAVIGATION.md must keep its §3 after §2").toBeGreaterThan(start);
  return navigation.slice(start, end);
}

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

  it("every route App owns is named by a signed story", () => {
    const routes = appRoutes();
    expect(routes.length).toBeGreaterThan(0);
    expect(registry.stories.length).toBeGreaterThan(0);
    const states = new Map(registry.stories.map((story) => [story.id, story.state]));
    for (const route of routes) {
      const storyId = ROUTE_ALLOWLIST[route];
      expect(
        storyId,
        `${route} is rendered by App.tsx but missing from ROUTE_ALLOWLIST — ` +
          "add it with the signed story that ships it",
      ).toBeDefined();
      if (!storyId) continue;
      const state = states.get(storyId);
      expect(
        state,
        `${route} is allowlisted to ${storyId}, which is not a story in registry.json`,
      ).toBeDefined();
      if (state === undefined) continue;
      expect(
        SIGNED_STATES.has(state),
        `${route} is allowlisted to ${storyId} (${state}); ` +
          "only a covered or approved story may name a route",
      ).toBe(true);
      const story = readFileSync(
        new URL(`../../../docs/product/stories/${storyId}.md`, import.meta.url),
        "utf8",
      );
      expect(story, `${storyId} is cited for ${route} but its file never names it`).toContain(
        `\`${route}\``,
      );
    }
  });

  it("the allowlist and the NAVIGATION.md route table name the same routes", () => {
    // §2 is the signed route contract. Collecting backticked route-shaped
    // tokens (rather than substring matching) means a row and a prose mention
    // are held to the same set, and dropping the query suffix compares the
    // route, not one state of it.
    const documented = new Set(
      [...navigationRouteSection().matchAll(/`([^`]+)`/g)]
        .map((match) => match[1])
        .filter((token) => token === "*" || token.startsWith("/"))
        .map((token) => token.split("?")[0]),
    );
    expect(documented.size).toBeGreaterThan(0);
    const allowed = new Set(Object.keys(ROUTE_ALLOWLIST));
    for (const route of documented) {
      expect(
        allowed.has(route),
        `NAVIGATION.md §2 names ${route}, but ROUTE_ALLOWLIST does not — ` +
          "add the signed story that ships it or remove the row",
      ).toBe(true);
    }
    for (const route of allowed) {
      expect(
        documented.has(route),
        `${route} is allowlisted but NAVIGATION.md §2 has no row for it — ` +
          "the route table is the signed contract",
      ).toBe(true);
    }
  });

  it("the allowlist matches the routes App renders exactly", () => {
    // Set equality, so a deleted <Route> leaves a stale entry red as well.
    const rendered = new Set(appRoutes());
    const allowed = new Set(Object.keys(ROUTE_ALLOWLIST));
    expect(rendered.size).toBeGreaterThan(0);
    for (const route of rendered) {
      expect(
        allowed.has(route),
        `${route} is rendered by App.tsx but is not in ROUTE_ALLOWLIST`,
      ).toBe(true);
    }
    for (const route of allowed) {
      expect(
        rendered.has(route),
        `${route} is in ROUTE_ALLOWLIST but App.tsx no longer renders it — ` +
          "remove the stale entry with its route",
      ).toBe(true);
    }
  });

  it("the superseded one-list-page phone model is gone", () => {
    expect(navigation).not.toContain("手机只有一个导航面");
    expect(navigation).not.toContain("没有 tab");
    expect(navigation).toContain("三个区域");
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

  it("IA.md keeps D8's four phone entries, both /projects redirects and the title-to-filter contract", () => {
    for (const phrase of [
      "对话列表",
      "例行任务",
      "Agent 运维",
      "设置",
      "D8",
      "/projects",
      "/projects/:id",
      // The cover is retired: both URLs replace themselves with the one list,
      // and a project's name narrows that list rather than pushing a page.
      "旧封面 URL 以 `replace` 落到按项目收窄的对话列表",
      "任务头的项目名",
      "筛选条上留一枚写着项目名的可清除 chip",
    ]) {
      expect(ia).toContain(phrase);
    }
    // The retired collection and cover may survive only as redirects.
    expect(ia).toContain("重定向");
    expect(ia).not.toContain("项目封面的父级是对话列表");
  });
});
