import { describe, expect, it } from "vitest";
import {
  nextSettingsTabId,
  offscreenEdges,
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

describe("offscreenEdges", () => {
  it("fades nothing when every tab fits", () => {
    expect(offscreenEdges(0, 700, 700)).toEqual({ start: false, end: false });
  });

  it("fades only the far edge at the start of an overflowing strip", () => {
    // The state the settings page opens in: seven tabs, the selected one can be
    // half-cut at the right, and nothing says there is more.
    expect(offscreenEdges(0, 358, 451)).toEqual({ start: false, end: true });
  });

  it("fades both edges in the middle", () => {
    expect(offscreenEdges(50, 358, 451)).toEqual({ start: true, end: true });
  });

  it("fades only the near edge at the end", () => {
    expect(offscreenEdges(93, 358, 451)).toEqual({ start: true, end: false });
  });

  it("tolerates fractional scroll positions", () => {
    // A trackpad or a zoomed page reports positions like 0.5 and 92.9999, which
    // would otherwise leave a fade showing at an edge with nothing behind it.
    expect(offscreenEdges(0.5, 358, 451)).toEqual({ start: false, end: true });
    expect(offscreenEdges(92.7, 358, 451)).toEqual({ start: true, end: false });
  });
});
