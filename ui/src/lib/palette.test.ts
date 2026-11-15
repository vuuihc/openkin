import { describe, expect, it } from "vitest";
import { AREAS, MAC_NAV_AREA_IDS, areaById, type AreaId } from "./areas";
import { PANELS, PANEL_IDS, availablePanels, panelById, type PanelContext } from "./panels";
import { paletteEntries } from "./palette";

/**
 * The palette is generated, so what is left to guard is that it is generated from
 * the right questions: that every area and every panel turns up without being
 * listed here, that availability is asked rather than assumed, and that the order
 * and the shortcut hints come from the tables.
 *
 * Its label coverage is not repeated here: `areas.test.ts` walks every area's
 * `labelKey` and `panels.test.ts` every panel's `titleKey`, and those are the
 * same keys this module passes through.
 */

/** A context with every answer set, so a test can vary one without the others deciding. */
function ctx(over: Partial<PanelContext> = {}): PanelContext {
  return { taskId: "task-1", remote: true, desktop: true, ...over };
}

const idsOf = (entries: ReturnType<typeof paletteEntries>, kind: "area" | "panel") =>
  entries.filter((e) => e.kind === kind).map((e) => e.id);

function areaEntry(id: AreaId) {
  const entry = paletteEntries(ctx()).find((e) => e.kind === "area" && e.id === id);
  if (!entry || entry.kind !== "area") throw new Error(`no area entry: ${id}`);
  return entry;
}

describe("paletteEntries", () => {
  // The whole point of the module: a destination exists in the palette because
  // the area table has it, in the table's order and under the table's name. A
  // hand-written list is what this replaced, and its failure mode was a place
  // that existed on one surface and not another.
  it("lists one entry per area the table marks for navigation", () => {
    const entries = paletteEntries(ctx());
    expect(idsOf(entries, "area")).toEqual([...MAC_NAV_AREA_IDS]);
    // Count and order are the table's, including the `macNav` filter itself.
    expect(idsOf(entries, "area")).toEqual(
      AREAS.filter((area) => area.macNav).map((area) => area.id),
    );
    expect(idsOf(entries, "area")).toHaveLength(4);
  });

  it("points the projects entry at the projects collection", () => {
    const projects = areaEntry("projects");
    expect(projects.path).toBe("/projects");
    expect(projects.path).not.toContain(":");
    expect(projects.labelKey).toBe("nav.projects");
  });

  // Every area, whatever the shell context, and the panels that apply here.
  it("offers every area, and every panel that applies here", () => {
    const entries = paletteEntries(ctx());
    expect(idsOf(entries, "area")).toEqual([...MAC_NAV_AREA_IDS]);
    expect(idsOf(entries, "panel")).toEqual([...PANEL_IDS]);
  });

  // Availability is the panel table's answer, not the palette's: `availablePanels`
  // is the same call the session header uses to decide whether to draw the panel's
  // own toggle, so the palette cannot offer a surface the header refuses to open.
  it("asks the panel table instead of deciding for itself", () => {
    for (const c of [
      ctx(),
      ctx({ desktop: false }),
      ctx({ taskId: null }),
      ctx({ taskId: null, remote: false, desktop: false }),
    ]) {
      expect(idsOf(paletteEntries(c), "panel")).toEqual(availablePanels(c).map((p) => p.id));
      // The shell context never changes which destinations exist.
      expect(idsOf(paletteEntries(c), "area")).toEqual([...MAC_NAV_AREA_IDS]);
    }
    // Stated outright for the two that matter, so a mutant that stops asking
    // cannot pass by agreeing with a table that grew a row.
    expect(idsOf(paletteEntries(ctx({ desktop: false })), "panel")).not.toContain("terminal");
    // The shell asks with no session in front, which is the context the palette
    // actually runs in: publishing stays (it is about where the session runs, and
    // the sheet opens from a page that has one), and the terminal is the rest.
    expect(idsOf(paletteEntries(ctx({ taskId: null })), "panel")).toEqual(["publish", "terminal"]);
    expect(idsOf(paletteEntries(ctx({ taskId: null, remote: false })), "panel")).toEqual([
      "terminal",
    ]);
    // The phone keeps every area: the footer carries four of them and the palette the rest.
    expect(idsOf(paletteEntries(ctx({ desktop: false })), "area")).toEqual([...MAC_NAV_AREA_IDS]);
  });

  it("keeps the tables' order", () => {
    expect(paletteEntries(ctx()).map((e) => `${e.kind}:${e.id}`)).toEqual([
      ...MAC_NAV_AREA_IDS.map((id) => `area:${id}`),
      ...PANELS.map((p) => `panel:${p.id}`),
    ]);
  });

  // The hint column is a promise about the keyboard, so it travels with the row
  // rather than being decided at the surface that draws it: the key handler and
  // the hint have to agree, and a literal in each is two chances to disagree.
  it("carries the shortcut each row promises", () => {
    const byKey = new Map(paletteEntries(ctx()).map((e) => [`${e.kind}:${e.id}`, e]));
    const hintOf = (key: string) => {
      const entry = byKey.get(key);
      return entry?.kind === "panel" ? entry.hint : undefined;
    };
    expect(hintOf("panel:terminal")).toBe("Ctrl+`");
    // An area is a destination, not a key chord; no row invents one.
    expect(hintOf("area:conversations")).toBeUndefined();
  });

  // A row's id is handed straight to the surface that acts on it — `navigate(entry
  // .path)` for an area, `onTogglePanel(entry.id)` (which resolves the panel to
  // decide what to open) for a panel. Both of those throw on an id they do not
  // know, at click time, in front of the user; this is the same lookup, here.
  it("hands the surfaces ids they can act on", () => {
    for (const entry of paletteEntries(ctx())) {
      if (entry.kind === "area") {
        const area = areaById(entry.id);
        expect(area.root).toBe(entry.path);
        expect(area.icon).toBe(entry.icon);
      } else {
        expect(panelById(entry.id).id).toBe(entry.id);
      }
    }
  });
});
