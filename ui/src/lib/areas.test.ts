import { describe, expect, it } from "vitest";
import { AREAS, AREA_IDS, MAC_NAV_AREA_IDS, areaById } from "./areas";

// KIN-CONTRACT-001: the console has three areas and they are one table. These
// assertions are deliberately DOM-free and catalog-free — the table is data,
// and every surface renders it.

describe("AREAS", () => {
  it("AREA_IDS and table rows cover exactly the three areas in display order", () => {
    expect(AREA_IDS).toEqual(["conversations", "routines", "settings"]);
    expect(AREAS.map((area) => area.id)).toEqual([...AREA_IDS]);
    expect(new Set(AREAS.map((area) => area.id)).size).toBe(AREAS.length);
    // One row each, so a copy-paste cannot give two areas the same destination
    // or the same name in the chrome.
    expect(AREAS.map((area) => area.root)).toEqual(["/sessions", "/routines", "/settings"]);
    expect(AREAS.map((area) => area.icon)).toEqual(["sessions", "routines", "settings"]);
    expect(AREAS.map((area) => area.labelKey)).toEqual([
      "nav.sessions",
      "nav.routines",
      "nav.settings",
    ]);
  });

  it("every area has a root, icon id, label key and distinct Mac-nav membership", () => {
    for (const area of AREAS) {
      expect({ id: area.id, rooted: area.root.startsWith("/") }).toEqual({
        id: area.id,
        rooted: true,
      });
      expect({ id: area.id, icon: /^[a-z][a-z0-9-]*$/.test(area.icon) }).toEqual({
        id: area.id,
        icon: true,
      });
      expect({ id: area.id, label: /^nav\.[a-z]+$/.test(area.labelKey) }).toEqual({
        id: area.id,
        label: true,
      });
      expect(typeof area.macNav).toBe("boolean");
      // An area root is the bottom of its phone stack: leaving Kin, not a
      // synthesized parent, is what sits underneath it (story map, stack rule 4).
      expect(area.phoneParent).toBeNull();
    }
  });

  // Mac membership is its own value rather than "everything in the table" read
  // off the array: the three roots all belong to Mac navigation today, and a
  // future area can join the phone model without silently entering the sidebar.
  it("encodes Mac navigation membership separately from the phone roots", () => {
    expect(MAC_NAV_AREA_IDS).toEqual(AREAS.filter((area) => area.macNav).map((area) => area.id));
    expect(MAC_NAV_AREA_IDS).toEqual([...AREA_IDS]);
  });

  // KIN-CONTRACT-001: the project level lives in the conversation list, not in
  // a fourth area. `/projects` stays reachable as a redirect only.
  it("has no projects area row after the collection retires", () => {
    expect(AREAS.map((area) => area.root as string)).not.toContain("/projects");
    expect(AREA_IDS as readonly string[]).not.toContain("projects");
    expect(MAC_NAV_AREA_IDS).toEqual(["conversations", "routines", "settings"]);
  });

  it("areaById returns the same table row rather than a divergent copy", () => {
    for (const id of AREA_IDS) {
      expect(areaById(id)).toBe(AREAS.find((area) => area.id === id));
    }
    expect(() => areaById("tray" as never)).toThrow(/unknown area/);
  });
});
