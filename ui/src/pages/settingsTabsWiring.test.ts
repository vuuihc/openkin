// KIN-SETTINGS-001 — 改默认设置（J6）：本套件持有六组目录与已删面板的验收行。
import { readFileSync } from "node:fs";
import { join } from "node:path";
import { fileURLToPath } from "node:url";
import { describe, expect, it } from "vitest";
import { normalizeSettingsTab } from "../lib/areaNavigation";

/**
 * The settings page's tab set, checked at the seam a panel test cannot see.
 *
 * KIN-CONTINUE-003 row 14: the six sections stay distinct — `agents` is the
 * local section, `operations` is Agent Ops — and retired tabs stay retired.
 *
 * R0b-3 deleted the Remote and Notifications tabs: nothing in the console
 * configures a tunnel or a push registration any more, because the phone's
 * loop goes through the Hub and notification permission belongs to the
 * system. The parse function sends old `?tab=` links to General, but it
 * cannot notice a tab added back to this list — only this file can.
 *
 * Source rather than DOM: mounting the page needs a daemon, a provider
 * catalog and a machine list.
 */
const UI = fileURLToPath(new URL("../..", import.meta.url));
const SOURCE = readFileSync(join(UI, "src/pages/SettingsPage.tsx"), "utf8");

function declaredTabIds(): string[] {
  const start = SOURCE.indexOf("const settingsTabs: SettingsTabItem[] = [");
  const end = SOURCE.indexOf("];", start);
  expect(start).toBeGreaterThan(-1);
  const body = SOURCE.slice(start, end);
  return [...body.matchAll(/\bid: "([a-z]+)"/g)].map((match) => match[1]);
}

describe("the settings page tabs", () => {
  it("offers exactly the six settings that are still used", () => {
    // N4 hosts the agent console as `operations`, right after the local
    // `agents` section. The order is the strip order on a desktop and the
    // "more sections" order on a phone, so it is asserted, not just the set.
    expect(declaredTabIds()).toEqual([
      "general",
      "agents",
      "operations",
      "providers",
      "routing",
      "advanced",
    ]);
  });

  // N4 hosts the page; it does not move the route. `/agents` keeps working
  // exactly as today until E4a removes it, so a deep link, a bookmark or a
  // notification that names it still lands.
  it("still routes /agents on its own", () => {
    const app = readFileSync(join(UI, "src/App.tsx"), "utf8");
    expect(app).toContain('<Route path="/agents"');
  });

  // N2: the tab ids come from the area table now, so this is the one parse the
  // page and a notification link share. A retired id can only ever be General.
  it("normalizes an unknown tab to general", () => {
    for (const retired of ["remote", "notifications", "nope", "", null]) {
      expect(normalizeSettingsTab(retired)).toBe("general");
    }
    expect(normalizeSettingsTab("operations")).toBe("operations");
    expect(normalizeSettingsTab("routing")).toBe("routing");
  });

  // The page reads its tab through that one function now; a second parse is how
  // the page and a notification link could disagree about what `?tab=` means.
  it("reads the initial tab through the area table", () => {
    expect(SOURCE).toContain("normalizeSettingsTab");
    expect(SOURCE).not.toContain("settingsTabFromSearch");
  });

  it("renders no retired panel", () => {
    expect(SOURCE).not.toContain('id="remote"');
    expect(SOURCE).not.toContain('id="notifications"');
    expect(SOURCE).not.toContain("NativePushSettings");
    expect(SOURCE).not.toContain("PhoneSection");
    expect(SOURCE).not.toContain("RelayGuidance");
  });
});
