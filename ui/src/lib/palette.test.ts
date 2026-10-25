import { describe, expect, it } from "vitest";
import { PANELS, PANEL_IDS, availablePanels, panelById, type PanelContext } from "./panels";
import { paletteEntries } from "./palette";
import { PLACES, PLACE_IDS, placePath } from "./places";

/**
 * The palette is generated, so what is left to guard is that it is generated from
 * the right questions: that every place and every panel turns up without being
 * listed here, that availability is asked rather than assumed, and that the order
 * and the shortcut hints come from the tables.
 *
 * Its label coverage is not repeated here: `places.test.ts` walks every place's
 * `labelKey` and `panels.test.ts` every panel's `titleKey`, and those are the same
 * keys this module passes through.
 */

/** A context with every answer set, so a test can vary one without the others deciding. */
function ctx(over: Partial<PanelContext> = {}): PanelContext {
  return { taskId: "task-1", remote: true, desktop: true, ...over };
}

const idsOf = (entries: ReturnType<typeof paletteEntries>, kind: "place" | "panel") =>
  entries.filter((e) => e.kind === kind).map((e) => e.id);

describe("paletteEntries", () => {
  // The whole point of the module: a place or a panel that exists in its table
  // turns up in the palette by existing. A hand-written list is what this
  // replaced, and its failure mode was a place nobody could reach from ⌘K.
  it("offers every place, and every panel that applies here", () => {
    const entries = paletteEntries(ctx());
    expect(idsOf(entries, "place")).toEqual([...PLACE_IDS]);
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
    // The phone keeps every place: the drawer is the only way to them there.
    expect(idsOf(paletteEntries(ctx({ desktop: false })), "place")).toEqual([...PLACE_IDS]);
  });

  it("keeps the tables' order", () => {
    expect(paletteEntries(ctx()).map((e) => `${e.kind}:${e.id}`)).toEqual([
      ...PLACES.map((p) => `place:${p.id}`),
      ...PANELS.map((p) => `panel:${p.id}`),
    ]);
  });

  // The hint column is a promise about the keyboard, so it travels with the row
  // rather than being decided at the surface that draws it: the key handler and
  // the hint have to agree, and a literal in each is two chances to disagree.
  it("carries the shortcut each row promises", () => {
    const byKey = new Map(paletteEntries(ctx()).map((e) => [`${e.kind}:${e.id}`, e]));
    expect(byKey.get("place:new")?.hint).toBe("⌘N");
    expect(byKey.get("panel:terminal")?.hint).toBe("Ctrl+`");
    // A row with no shortcut says so by having none, rather than by an empty string
    // the palette would draw as a blank column.
    expect(byKey.get("place:sessions")?.hint).toBeUndefined();
  });

  // A row's id is handed straight to the surface that acts on it — `navigate(entry
  // .path)` for a place, `onTogglePanel(entry.id)` (which resolves the panel to
  // decide what to open) for a panel. Both of those throw on an id they do not
  // know, at click time, in front of the user; this is the same lookup, here.
  it("hands the surfaces ids they can act on", () => {
    for (const entry of paletteEntries(ctx())) {
      if (entry.kind === "place") expect(placePath(entry.id)).toBe(entry.path);
      else expect(panelById(entry.id).id).toBe(entry.id);
    }
  });
});
