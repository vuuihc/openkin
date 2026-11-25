// @vitest-environment jsdom
// KIN-SETTINGS-001 — 改默认设置（J6）：本套件持有目录 / 内容列布局与键盘焦点的验收行。
import { createElement, useState } from "react";
import { act, fireEvent, render, screen, within } from "@testing-library/react";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import {
  nextSettingsTabId,
  offscreenEdges,
  settingsTabFromSearch,
  SettingsLayout,
  SettingsTabPanel,
  type SettingsTabId,
  type SettingsTabItem,
} from "./SettingsPrimitives";

const tabs: SettingsTabItem[] = [
  { id: "general", label: "General", description: "General settings" },
  { id: "agents", label: "Agents", description: "Agent settings" },
  { id: "providers", label: "Providers", description: "Provider settings" },
];

/**
 * jsdom has no `matchMedia`, and the tabs' touch floor follows the pointer
 * rather than the viewport width, so the floor cases declare the pointer they
 * run on. Every other case keeps the fallback, which is the mouse.
 */
function setPointer(coarse: boolean) {
  vi.stubGlobal("matchMedia", (query: string) => ({
    matches: query === "(pointer: coarse)" ? coarse : false,
    media: query,
    onchange: null,
    addEventListener: vi.fn(),
    removeEventListener: vi.fn(),
    addListener: vi.fn(),
    removeListener: vi.fn(),
    dispatchEvent: vi.fn(),
  }));
}

/** Whole class tokens, never substrings: `sm:min-h-10` must not satisfy `min-h-10`. */
function classes(element: HTMLElement): string[] {
  return element.className.split(/\s+/).filter(Boolean);
}

/** A stateful parent, the way the settings page owns the active tab. */
function layoutHarness(initial: SettingsTabId, items: SettingsTabItem[]) {
  return function Harness() {
    const [active, setActive] = useState<SettingsTabId>(initial);
    return createElement(SettingsLayout, {
      title: "Settings",
      tabs: items,
      activeTab: active,
      onTabChange: setActive,
      children: createElement("div", null, "panel"),
    });
  };
}

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

describe("SettingsLayout focus recovery", () => {
  // Operations is last so ArrowRight from Advanced reaches it.
  const laidOut: SettingsTabItem[] = [
    ...tabs,
    { id: "advanced", label: "Advanced", description: "Advanced settings" },
    { id: "operations", label: "Operations", description: "Operations settings" },
  ];

  beforeEach(() => {
    Element.prototype.scrollIntoView = vi.fn();
  });

  it("moves focus to the visible back row when a selection hides the tab", () => {
    // Selecting Operations hides the whole section column, so the tab that had
    // focus is no longer rendered and the browser drops focus to <body>. The
    // back row is the visible control that must receive it.
    render(createElement(layoutHarness("advanced", laidOut)));
    const operationsTab = screen.getByRole("tab", { name: "Operations" });
    act(() => {
      operationsTab.focus();
      operationsTab.dispatchEvent(new MouseEvent("click", { bubbles: true }));
      (document.activeElement as HTMLElement | null)?.blur();
    });
    expect(document.activeElement).toBe(screen.getByRole("button", { name: "Settings" }));
  });

  it("moves focus to the back row when arrow keys select Operations", () => {
    const frames: FrameRequestCallback[] = [];
    const raf = vi
      .spyOn(window, "requestAnimationFrame")
      .mockImplementation((callback) => frames.push(callback));
    try {
      render(createElement(layoutHarness("advanced", laidOut)));
      screen.getByRole("tab", { name: "Advanced" }).focus();
      fireEvent.keyDown(screen.getByRole("tablist", { name: "Settings" }), {
        key: "ArrowRight",
      });
      act(() => {
        frames.forEach((callback) => callback(0));
      });
      expect(document.activeElement).toBe(screen.getByRole("button", { name: "Settings" }));
    } finally {
      raf.mockRestore();
    }
  });
});

describe("SettingsLayout summaries and phone focus", () => {
  const withSummary: SettingsTabItem[] = [
    { id: "general", label: "General", description: "General settings" },
    {
      id: "providers",
      label: "Providers",
      description: "Provider settings",
      summary: "Anthropic",
    },
  ];

  /** The phone directory row that carries a section's description. */
  function phoneRow(detail: string): HTMLElement {
    const node = screen.getByText(detail).closest("button");
    expect(node).toBeTruthy();
    return node as HTMLElement;
  }

  /** The layout with two real panels, so focus can land inside one. */
  function panelHarness(items: SettingsTabItem[], controlInProviders = true) {
    return function Harness() {
      const [active, setActive] = useState<SettingsTabId>("general");
      return createElement(SettingsLayout, {
        title: "Settings",
        tabs: items,
        activeTab: active,
        onTabChange: setActive,
        children: [
          createElement(SettingsTabPanel, {
            key: "general",
            id: "general",
            active: active === "general",
            children: createElement("button", { type: "button" }, "Theme control"),
          }),
          createElement(SettingsTabPanel, {
            key: "providers",
            id: "providers",
            active: active === "providers",
            children: controlInProviders
              ? createElement("button", { type: "button" }, "Provider control")
              : "Nothing to focus yet",
          }),
        ],
      });
    };
  }

  beforeEach(() => {
    Element.prototype.scrollIntoView = vi.fn();
    // jsdom has no layout engine; the directory tap scrolls the page to the top.
    Element.prototype.scrollTo = vi.fn();
  });

  it("shows each section's current value in the Mac nav and the phone directory", () => {
    // The value is a glance aid on both surfaces: the tab strip already names
    // the section, and the phone's directory row has the room for it.
    render(createElement(layoutHarness("general", withSummary)));

    const tab = screen.getByRole("tab", { name: "Providers" });
    expect(within(tab).getByText("Anthropic")).toBeTruthy();

    const row = phoneRow("Provider settings");
    expect(within(row).getByText("Anthropic")).toBeTruthy();
  });

  it("keeps the description when a section has no value yet", () => {
    // No value is the fallback, not an empty second line: a section whose
    // current value is not known keeps its description and nothing else.
    render(createElement(layoutHarness("general", tabs)));

    const tab = screen.getByRole("tab", { name: "Providers" });
    expect(tab.textContent).toBe("Providers");
    expect(tab.getAttribute("title")).toBe("Provider settings");

    const row = phoneRow("Provider settings");
    expect(row.textContent).toBe("ProvidersProvider settings");
  });

  it("choosing a section from the phone directory moves focus into its panel", () => {
    render(createElement(panelHarness(withSummary)));

    fireEvent.click(phoneRow("Provider settings"));

    // The directory that held the tapped row is gone; focus belongs to the
    // layer that just appeared, not to <body>.
    expect(document.activeElement).toBe(screen.getByRole("button", { name: "Provider control" }));
  });

  it("falls back to the panel itself when the section has no control to focus", () => {
    render(createElement(panelHarness(withSummary, false)));

    fireEvent.click(phoneRow("Provider settings"));

    expect(document.activeElement).toBe(document.getElementById("settings-panel-providers"));
  });

  it("choosing a section from the Mac tab strip keeps focus on the tab", () => {
    // The ARIA tablist keeps focus on the tab; arrow keys already move it, and
    // a panel focus move here would fight that pattern.
    render(createElement(panelHarness(withSummary)));

    const tab = screen.getByRole("tab", { name: "Providers" });
    tab.focus();
    fireEvent.click(tab);

    expect(document.activeElement).toBe(tab);
  });
});

describe("the settings section tabs' touch floor", () => {
  // TASTE 21 / AGENTS.md §16: the floor follows the pointer, not the width.
  // `sm:min-h-10` shrank every tab to 40px at ≥640px regardless of pointer, so
  // an iPad in portrait (820px, a thumb) got a 40px target.

  beforeEach(() => {
    Element.prototype.scrollIntoView = vi.fn();
  });

  afterEach(() => {
    vi.unstubAllGlobals();
  });

  function renderTabs() {
    render(
      createElement(SettingsLayout, {
        title: "Settings",
        tabs,
        activeTab: "general" as const,
        onTabChange: () => undefined,
        children: createElement("div", null, "panel"),
      }),
    );
  }

  it("keeps every settings section tab at 44px on a coarse pointer at 820", () => {
    setPointer(true);
    renderTabs();

    const rows = screen.getAllByRole("tab").map((tab) => classes(tab));
    expect(rows).toHaveLength(tabs.length);
    for (const tokens of rows) {
      expect(tokens).toContain("min-h-11");
      // The width-only rule must not be in the class list at all: leaving it
      // there would win above 640px and put the 40px target back.
      expect(tokens).not.toContain("sm:min-h-10");
    }
  });

  it("keeps the settings section tabs at 40px on a fine pointer at 1100", () => {
    setPointer(false);
    renderTabs();

    const rows = screen.getAllByRole("tab").map((tab) => classes(tab));
    expect(rows).toHaveLength(tabs.length);
    for (const tokens of rows) {
      // The phone still gets 44px; above 640px a mouse keeps the dense 40px.
      expect(tokens).toContain("min-h-11");
      expect(tokens).toContain("sm:min-h-10");
    }
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
