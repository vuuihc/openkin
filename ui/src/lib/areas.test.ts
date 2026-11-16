import { describe, expect, it } from "vitest";
import { AREAS, AREA_IDS, MAC_NAV_AREA_IDS, areaById } from "./areas";

// KIN-CONTINUE-003: the four areas are one table. These assertions are
// deliberately DOM-free and catalog-free — N1 ships the contract, N2 adds the
// missing locale entries when a surface renders it.

describe("AREAS", () => {
  it("AREA_IDS and table rows cover exactly the four areas in display order", () => {
    expect(AREA_IDS).toEqual(["conversations", "projects", "routines", "settings"]);
    expect(AREAS.map((area) => area.id)).toEqual([...AREA_IDS]);
    expect(new Set(AREAS.map((area) => area.id)).size).toBe(AREAS.length);
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
    // One row each, so a copy-paste cannot give two areas the same destination
    // or the same name in the chrome.
    expect(AREAS.map((area) => area.root)).toEqual([
      "/sessions",
      "/projects",
      "/routines",
      "/settings",
    ]);
    expect(AREAS.map((area) => area.icon)).toEqual([
      "sessions",
      "projects",
      "routines",
      "settings",
    ]);
    expect(AREAS.map((area) => area.labelKey)).toEqual([
      "nav.sessions",
      "nav.projects",
      "nav.routines",
      "nav.settings",
    ]);
  });

  // Mac membership is its own value rather than "everything in the table" read
  // off the array: the four roots all belong to Mac navigation today, and a
  // future area can join the phone model without silently entering the sidebar.
  it("encodes Mac navigation membership separately from the phone roots", () => {
    expect(MAC_NAV_AREA_IDS).toEqual(AREAS.filter((area) => area.macNav).map((area) => area.id));
    expect(MAC_NAV_AREA_IDS).toEqual([...AREA_IDS]);
  });

  it("areaById returns the same table row rather than a divergent copy", () => {
    for (const id of AREA_IDS) {
      expect(areaById(id)).toBe(AREAS.find((area) => area.id === id));
    }
    expect(() => areaById("tray" as never)).toThrow(/unknown area/);
  });
});
