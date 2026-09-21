import { describe, expect, it } from "vitest";
import {
  nextSettingsTabId,
  settingsTabFromSearch,
  type SettingsTabItem,
} from "./SettingsPrimitives";

const tabs: SettingsTabItem[] = [
  { id: "general", label: "General", description: "General settings" },
  { id: "agents", label: "Agents", description: "Agent settings" },
  { id: "providers", label: "Providers", description: "Provider settings" },
];

describe("nextSettingsTabId", () => {
  it("moves forward and wraps for right/down arrows", () => {
    expect(nextSettingsTabId(tabs, "general", "ArrowRight")).toBe("agents");
    expect(nextSettingsTabId(tabs, "providers", "ArrowDown")).toBe("general");
  });

  it("moves backward and wraps for left/up arrows", () => {
    expect(nextSettingsTabId(tabs, "agents", "ArrowLeft")).toBe("general");
    expect(nextSettingsTabId(tabs, "general", "ArrowUp")).toBe("providers");
  });

  it("jumps to edges for home/end and ignores unrelated keys", () => {
    expect(nextSettingsTabId(tabs, "providers", "Home")).toBe("general");
    expect(nextSettingsTabId(tabs, "general", "End")).toBe("providers");
    expect(nextSettingsTabId(tabs, "agents", "Enter")).toBe("agents");
  });
});

describe("settingsTabFromSearch", () => {
  it("uses explicit tab search params", () => {
    expect(settingsTabFromSearch("?tab=providers")).toBe("providers");
    expect(settingsTabFromSearch("?tab=unknown")).toBe("general");
  });

  it("opens Remote for Cloudflare and Relay callback params", () => {
    expect(settingsTabFromSearch("?cloudflare=connected")).toBe("remote");
    expect(settingsTabFromSearch("?relay=connected")).toBe("remote");
  });
});
