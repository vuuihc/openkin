import { readFileSync } from "node:fs";
import { fileURLToPath } from "node:url";
import ts from "typescript";
import { describe, expect, it } from "vitest";
import { en, zh } from "../i18n";
import { PLACES, PLACE_IDS, placeById, placePath, sidebarNavSections } from "./places";

/**
 * The table every navigation surface is a view of, so what is worth pinning is
 * what a compiler cannot see: that each row is complete (a path, a name in both
 * locales), that the ids are one space rather than three, and — the one that
 * actually costs a user something — that the paths it hands out are paths the
 * router serves. A row pointing at nothing is a sidebar link and a palette row
 * that land on the catch-all and look like a broken app.
 */

/** Whether a locale catalog resolves a dotted key to a non-empty string. */
function has(catalog: unknown, path: string): boolean {
  let cur: unknown = catalog;
  for (const part of path.split(".")) {
    if (cur === null || typeof cur !== "object") return false;
    cur = (cur as Record<string, unknown>)[part];
  }
  return typeof cur === "string" && cur.trim() !== "";
}

/**
 * Routes that are deliberately not places, and why.
 *
 * The other direction of the same invariant: a page in the router and in no list
 * is a page nobody can reach, so the table has to cover the router — except where
 * the route says so itself. An entry here is a decision, not a silence, which is
 * the whole reason the list exists.
 */
const NOT_A_PLACE = new Map([
  [
    "/design",
    "the token gallery: App.tsx says it is a place to check the design layer, not a place to work",
  ],
]);

/**
 * The paths `App.tsx` serves, and whether each one redirects.
 *
 * Source rather than DOM for the reason `PanelSurface.test.ts` and
 * `design/tokens.test.ts` are source scans: the tree has no DOM test
 * environment by design, and "which paths exist" is a property of the source.
 * The parser is what keeps this honest — a regex over `<Route path="…"` would
 * quietly match nothing after a formatting change, and a guard that cannot fail
 * is worse than no guard.
 *
 * "Redirects" is read from the element: a `path` whose element is a `<Navigate>`
 * is a spelling of somewhere else (`/usage` → `/agents`), so it is not a page and
 * must not be a row — and a row pointing at one would be a place that bounces.
 */
function routes(): Map<string, boolean> {
  const file = fileURLToPath(new URL("../App.tsx", import.meta.url));
  const source = ts.createSourceFile(
    file,
    readFileSync(file, "utf8"),
    ts.ScriptTarget.Latest,
    true,
    ts.ScriptKind.TSX,
  );
  const out = new Map<string, boolean>();
  const visit = (node: ts.Node) => {
    if (ts.isJsxSelfClosingElement(node) || ts.isJsxOpeningElement(node)) {
      if (node.tagName.getText(source) === "Route") {
        let path: string | null = null;
        let redirects = false;
        for (const prop of node.attributes.properties) {
          if (!ts.isJsxAttribute(prop) || !prop.initializer) continue;
          const name = prop.name.getText(source);
          if (name === "path" && ts.isStringLiteral(prop.initializer)) path = prop.initializer.text;
          if (name === "element") redirects = /<Navigate/.test(prop.initializer.getText(source));
        }
        if (path !== null) out.set(path, redirects);
      }
    }
    ts.forEachChild(node, visit);
  };
  visit(source);
  return out;
}

/**
 * Whether a route is one the table has to account for.
 *
 * Detail routes (`/tasks/:id`) and the catch-all are not places: they are reached
 * from a row's subject rather than from the row itself.
 */
function isPlaceShaped(path: string): boolean {
  return !path.includes(":") && path !== "*";
}

describe("PLACES", () => {
  it("has one row per id, with no duplicates", () => {
    const ids = PLACES.map((p) => p.id);
    expect(new Set(ids).size).toBe(ids.length);
  });

  // The union is derived from `PLACE_IDS`, so an id can only be added to both at
  // once — and the row is a separate edit that this walks for. A missing row is a
  // `placeById` throw in the render path, which is a blank page.
  it("knows every id, and has a row for each", () => {
    for (const id of PLACE_IDS) {
      expect({ id, row: placeById(id).id }).toEqual({ id, row: id });
    }
    expect(PLACES.map((p) => p.id).sort()).toEqual([...PLACE_IDS].sort());
  });

  it("gives every place one path, and no two the same", () => {
    for (const place of PLACES) {
      expect({ id: place.id, rooted: place.path.startsWith("/") }).toEqual({
        id: place.id,
        rooted: true,
      });
    }
    const paths = PLACES.map((p) => p.path);
    expect(new Set(paths).size).toBe(paths.length);
  });

  // The table is data, so the one thing it cannot do is notice that its own
  // `labelKey` is a dotted path nobody translated — `t()` falls back to the path
  // string and the sidebar reads `nav.artifacts`.
  it("names every place in both locales", () => {
    for (const place of PLACES) {
      expect({
        id: place.id,
        en: has(en, place.labelKey),
        zh: has(zh, place.labelKey),
      }).toEqual({ id: place.id, en: true, zh: true });
    }
  });

  it("points only at paths the router serves, and at pages rather than redirects", () => {
    const served = routes();
    // Sanity: the scan found the router at all, so an empty answer is a broken
    // scan rather than a table that happens to be perfect.
    expect(served.size).toBeGreaterThan(5);
    const missing = PLACES.filter((p) => !served.has(p.path)).map((p) => `${p.id} → ${p.path}`);
    expect(missing).toEqual([]);
    const bounces = PLACES.filter((p) => served.get(p.path)).map((p) => `${p.id} → ${p.path}`);
    expect(bounces).toEqual([]);
  });

  // The half that was missing: the table can be complete and the router can still
  // grow a page nobody can reach — the failure `places.ts` names in its own
  // header ("a place that exists in the router and in no list is a place nobody
  // can reach"). A new `<Route>` is now red until it is either a row or an entry
  // in `NOT_A_PLACE` with a reason.
  it("covers the router: every page is a row, or exempt on the record", () => {
    const rows = new Set(PLACES.map((p) => p.path));
    const uncovered = [...routes()]
      .filter(([path, redirects]) => isPlaceShaped(path) && !redirects)
      .map(([path]) => path)
      .filter((path) => !rows.has(path) && !NOT_A_PLACE.has(path));
    expect(uncovered).toEqual([]);
  });

  it("keeps the exemption list honest, so it cannot rot", () => {
    const served = routes();
    const rows = new Set(PLACES.map((p) => p.path));
    const stale = [...NOT_A_PLACE.keys()].filter(
      (path) => !served.has(path) || served.get(path) === true || rows.has(path),
    );
    expect(stale).toEqual([]);
  });
});

describe("placePath", () => {
  it("answers the row's path for every place", () => {
    for (const id of PLACE_IDS) {
      expect(placePath(id)).toBe(placeById(id).path);
    }
  });
});

describe("sidebarNavSections", () => {
  it("renders the two groups in order", () => {
    expect(sidebarNavSections().map((s) => s.id)).toEqual(["library", "operations"]);
  });

  it("fills each group from the one table", () => {
    const sections = sidebarNavSections();
    const library = sections.find((s) => s.id === "library");
    const operations = sections.find((s) => s.id === "operations");
    expect(library?.items.map((i) => i.id)).toEqual(["artifacts", "routines", "projects"]);
    expect(operations?.items.map((i) => i.id)).toEqual(["agents", "settings"]);
    // The work set belongs to the phone's bar and the draft, not to this footer —
    // and this is the assertion that says so, rather than a filter nobody wrote
    // down: the sidebar reaches those destinations through its project list.
    const shown = sections.flatMap((s) => s.items.map((i) => i.id));
    expect(shown).not.toContain("sessions");
    expect(shown).not.toContain("inbox");
  });

  it("gives every group a name and something to put under it", () => {
    for (const section of sidebarNavSections()) {
      expect({ id: section.id, named: has(en, section.labelKey) }).toEqual({
        id: section.id,
        named: true,
      });
      expect(section.items.length).toBeGreaterThan(0);
    }
  });
});
