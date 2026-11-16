// @vitest-environment jsdom
import { createElement } from "react";
import { render, screen, within } from "@testing-library/react";
import { beforeEach, describe, expect, it, vi } from "vitest";
import {
  nextSettingsTabId,
  offscreenEdges,
  settingsTabFromSearch,
  SettingsLayout,
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

  it("accepts operations as a tab and still falls back for retired ids", () => {
    expect(settingsTabFromSearch("?tab=operations")).toBe("operations");
    expect(settingsTabFromSearch("?tab=remote")).toBe("general");
  });

  it("sends the retired tabs and their callback params to General", () => {
    // Remote and Notifications were removed in R0b-3. Old links and OAuth
    // callbacks must land on a tab that exists, not on a blank panel.
    expect(settingsTabFromSearch("?tab=remote")).toBe("general");
    expect(settingsTabFromSearch("?tab=notifications")).toBe("general");
    expect(settingsTabFromSearch("?cloudflare=connected")).toBe("general");
    expect(settingsTabFromSearch("?relay=connected")).toBe("general");
  });
});

describe("SettingsLayout", () => {
  beforeEach(() => {
    Element.prototype.scrollIntoView = vi.fn();
  });

  it("renders the Mac section nav as a vertical tablist", () => {
    const sixTabs: SettingsTabItem[] = [
      { id: "general", label: "General", description: "General settings" },
      { id: "agents", label: "Agents", description: "Agent settings" },
      { id: "operations", label: "Operations", description: "Operations settings" },
      { id: "providers", label: "Providers", description: "Provider settings" },
      { id: "routing", label: "Routing", description: "Routing settings" },
      { id: "advanced", label: "Advanced", description: "Advanced settings" },
    ];

    render(
      createElement(SettingsLayout, {
        title: "Settings",
        tabs: sixTabs,
        activeTab: "general" as const,
        onTabChange: () => undefined,
        children: createElement("div", null, "panel"),
      }),
    );

    const tablist = screen.getByRole("tablist", { name: "Settings" });
    expect(tablist.getAttribute("aria-orientation")).toBe("vertical");
    expect(within(tablist).getAllByRole("tab")).toHaveLength(6);
  });
});

describe("SettingsLayout content column", () => {
  beforeEach(() => {
    Element.prototype.scrollIntoView = vi.fn();
  });

  function contentColumn(activeTab: "operations" | "advanced") {
    const laidOut: SettingsTabItem[] = [
      ...tabs,
      { id: "operations", label: "Operations", description: "Operations settings" },
      { id: "advanced", label: "Advanced", description: "Advanced settings" },
    ];
    const { unmount } = render(
      createElement(SettingsLayout, {
        title: "Settings",
        tabs: laidOut,
        activeTab,
        onTabChange: () => undefined,
        children: createElement("div", { id: "content-probe" }, "panel"),
      }),
    );
    const column = document.getElementById("content-probe")?.parentElement as HTMLElement;
    unmount();
    return column;
  }

  it("keeps Operations on the wide column and caps every other tab", () => {
    // Operations carries a 980px usage table; capping its column at the 620px
    // reading width made that table scroll sideways at 1100px.
    const operations = contentColumn("operations");
    expect(operations.className).not.toContain("md:max-w-[620px]");
    expect(operations.className).toContain("flex-1");

    expect(contentColumn("advanced").className).toContain("md:max-w-[620px]");
  });

  it("gives Operations the whole page and the back row instead of the section column", () => {
    // The 980px usage table cannot share the 1100px page with the 224px
    // section column: at a 1100px window that left ~708px and pushed the last
    // four columns off-screen. Operations gives the column up, and the quiet
    // back row — the shape the phone already uses — is the way to the list.
    const laidOut: SettingsTabItem[] = [
      ...tabs,
      { id: "operations", label: "Operations", description: "Operations settings" },
      { id: "advanced", label: "Advanced", description: "Advanced settings" },
    ];
    const layout = (activeTab: "operations" | "advanced") =>
      render(
        createElement(SettingsLayout, {
          title: "Settings",
          tabs: laidOut,
          activeTab,
          onTabChange: () => undefined,
          children: createElement("div", null, "panel"),
        }),
      );

    const operations = layout("operations");
    expect(
      (screen.getByRole("tablist", { name: "Settings" }).parentElement as HTMLElement).className,
    ).toContain("hidden");
    expect(screen.getByRole("button", { name: "Settings" }).className).not.toContain("md:hidden");
    operations.unmount();

    layout("advanced");
    expect(
      (screen.getByRole("tablist", { name: "Settings" }).parentElement as HTMLElement).className,
    ).toContain("md:w-56");
    expect(screen.getByRole("button", { name: "Settings" }).className).toContain("md:hidden");
  });
});

describe("offscreenEdges", () => {
  it("fades nothing when every tab fits", () => {
    expect(offscreenEdges(0, 700, 700)).toEqual({ start: false, end: false });
  });

  it("fades only the far edge at the start of an overflowing strip", () => {
    // The state the settings page opens in: five tabs, the selected one can be
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
