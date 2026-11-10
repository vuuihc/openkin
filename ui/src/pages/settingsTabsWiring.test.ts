import { readFileSync } from "node:fs";
import { join } from "node:path";
import { fileURLToPath } from "node:url";
import { describe, expect, it } from "vitest";

/**
 * The settings page's tab set, checked at the seam a panel test cannot see.
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
  it("offers exactly the five settings that are still used", () => {
    expect(declaredTabIds()).toEqual([
      "general",
      "agents",
      "providers",
      "routing",
      "advanced",
    ]);
  });

  it("renders no retired panel", () => {
    expect(SOURCE).not.toContain('id="remote"');
    expect(SOURCE).not.toContain('id="notifications"');
    expect(SOURCE).not.toContain("NativePushSettings");
    expect(SOURCE).not.toContain("PhoneSection");
    expect(SOURCE).not.toContain("RelayGuidance");
  });
});
