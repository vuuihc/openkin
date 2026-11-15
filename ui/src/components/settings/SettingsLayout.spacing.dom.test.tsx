// @vitest-environment jsdom
import { beforeEach, describe, expect, it, vi } from "vitest";
import { render, screen } from "@testing-library/react";
import { SettingsLayout, type SettingsTabItem } from "./SettingsPrimitives";

/**
 * R-settings-space-y-v4: Tailwind 4 implements `space-y-*` as a bottom margin on
 * every preceding sibling, not a top margin on every following one. The phone
 * header is a `hidden md:block` h1 sitting above the description, so on a phone
 * the hidden heading no longer contributed the 4px gap and the description and
 * the first card sat 4px high (measured 390x844: description ink 83 -> 79,
 * appearance card 117 -> 113). The description now owns a phone-only top
 * margin; desktop keeps its single `space-y-1` gap.
 *
 * jsdom has no layout engine, so the assertion is on the class contract that
 * carries the measurement above — the narrowest guard this suite can hold.
 */

const tabs: SettingsTabItem[] = [
  { id: "general", label: "General", description: "General settings" },
];

beforeEach(() => {
  Element.prototype.scrollIntoView = vi.fn();
  vi.stubGlobal(
    "ResizeObserver",
    class {
      observe() {}
      unobserve() {}
      disconnect() {}
    },
  );
});

function subtitle(): HTMLElement {
  render(
    <SettingsLayout
      title="Settings"
      subtitle="Shape how Kin works"
      tabs={tabs}
      activeTab="general"
      onTabChange={() => undefined}
    >
      <p>panel</p>
    </SettingsLayout>,
  );
  return screen.getByText("Shape how Kin works");
}

describe("settings header spacing", () => {
  it("restores the 4px gap above the description on the phone", () => {
    expect(subtitle().classList.contains("mt-1")).toBe(true);
  });

  it("does not double the gap on desktop", () => {
    // The phone margin is scoped to the phone: at md the h1 is visible again
    // and `space-y-1` supplies the one gap between heading and description.
    expect(subtitle().classList.contains("md:mt-0")).toBe(true);
  });
});
