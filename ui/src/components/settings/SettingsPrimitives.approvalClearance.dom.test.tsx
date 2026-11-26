// @vitest-environment jsdom
// R-settings-approval-clearance. The 2026-11-26 18:00 dogfood finding: at 390
// with another conversation's approval waiting, the floating 等待处理 strip
// (366×52 @ (12,610), bottom 662) covers the lower 17px of `/settings`'s last
// section row 高级 (324×61.5 @ (33,565), bottom 627), and the pane had no
// scroll room to bring it clear (`scrollHeight === clientHeight`). A real CDP
// touch 8px above the row's bottom opened `/tasks/01M8…` instead of
// `/settings?tab=advanced`. The strip stays — it is `/settings`'s only
// pending-approval entry (`rsi/DECISIONS.md:172`) — so the shared settings
// scroller reserves the band the strip publishes, exactly as the routines pane
// already does. With nothing pending the `0px` fallbacks keep today's footer
// clearance, and the rule lives in the phone media query so a desktop pane
// does not move.
import { readFileSync } from "node:fs";
import { join } from "node:path";
import { createElement } from "react";
import { cleanup, render } from "@testing-library/react";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { SettingsLayout, type SettingsTabItem } from "./SettingsPrimitives";

const tabs: SettingsTabItem[] = [
  { id: "general", label: "General", description: "General settings" },
  { id: "providers", label: "Providers", description: "Provider settings" },
  { id: "advanced", label: "Advanced", description: "Advanced settings" },
];

// jsdom has no `matchMedia`, and the layout reads the pointer for its touch
// floor, so the harness declares the pointer it runs on.
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

function renderLayout() {
  return render(
    createElement(SettingsLayout, {
      title: "Settings",
      tabs,
      activeTab: "advanced",
      onTabChange: () => undefined,
      children: createElement("div", null, "panel"),
    }),
  );
}

/** Whole class tokens, never substrings: `sm:min-h-10` must not satisfy `min-h-10`. */
function classes(element: HTMLElement): string[] {
  return element.className.split(/\s+/).filter(Boolean);
}

// jsdom rewrites import.meta.url to an http URL, so resolve from the package
// root Vitest runs in (ui/).
const SOURCE = readFileSync(
  join(process.cwd(), "src/components/settings/SettingsPrimitives.tsx"),
  "utf8",
);
const CSS = readFileSync(join(process.cwd(), "src/index.css"), "utf8");

beforeEach(() => {
  setPointer(false);
  Element.prototype.scrollIntoView = vi.fn();
});

afterEach(() => {
  cleanup();
  vi.unstubAllGlobals();
  vi.restoreAllMocks();
});

function scroller(view: ReturnType<typeof renderLayout>): HTMLElement {
  return view.container.firstElementChild as HTMLElement;
}

describe("SettingsLayout clears the approval strip", () => {
  it("R-settings-approval-clearance: the settings pane reserves the approval strip band on the phone", () => {
    const view = renderLayout();

    const pane = scroller(view);
    // The footer's clearance is still the base (`phoneFooterGlass.test.ts`
    // pins that class); the strip's band is the addition that scrolls the
    // last section row clear on a phone.
    expect(classes(pane)).toContain("phone-footer-clearance");
    expect(classes(pane)).toContain("phone-approval-clearance");
  });

  it("R-settings-approval-clearance: the settings scroller keeps today's footer clearance when no strip band is published", () => {
    renderLayout();

    // No FloatingApproval is mounted in this tree, so nothing has published a
    // band. The CSS fallbacks are what a page with nothing pending keeps: the
    // `0px` fallbacks make the max() resolve to exactly today's footer
    // clearance, so the page does not move.
    expect(document.documentElement.style.getPropertyValue("--approval-strip-height")).toBe("");
    expect(document.documentElement.style.getPropertyValue("--approval-strip-bottom")).toBe("");

    const rule = CSS.match(
      /@media \(max-width: 767\.98px\)\s*\{\s*\.phone-approval-clearance\s*\{([^}]*)\}/,
    );
    expect(rule, "the phone rule exists").not.toBeNull();
    const body = rule![1];
    expect(body).toMatch(/padding-bottom:\s*max\(\s*var\(--phone-footer-clearance\)/);
    expect(body).toMatch(/var\(--approval-strip-height,\s*0px\)/);
    expect(body).toMatch(/var\(--approval-strip-bottom,\s*0px\)/);
    expect(body).toMatch(/\+\s*8px/);
  });

  it("R-settings-approval-clearance: the settings clearance lives in the phone media query", () => {
    // The band is phone-only: at 1100 the settings pane shares no space with
    // the strip, so its scroller must not grow one. The rule consumes the
    // published variable rather than a guessed constant.
    expect(CSS).toMatch(
      /@media \(max-width: 767\.98px\)\s*\{\s*\.phone-approval-clearance\s*\{[^}]*padding-bottom:\s*max\([^}]*var\(--approval-strip-height,\s*0px\)[^}]*var\(--approval-strip-bottom,\s*0px\)[^}]*\)/,
    );
    // The scroller names it next to the footer class, not inside a page-local
    // inline style.
    expect(SOURCE).toContain("phone-footer-clearance phone-approval-clearance");
  });
});
