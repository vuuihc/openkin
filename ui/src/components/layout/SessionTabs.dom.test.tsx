// @vitest-environment jsdom
import { describe, expect, it, vi } from "vitest";
import { fireEvent, render, screen } from "@testing-library/react";
import { t } from "../../i18n";
import SessionTabs, { type SessionTab } from "./SessionTabs";

// The strip scrolls its active tab into view, and jsdom has no layout to scroll.
Element.prototype.scrollIntoView = vi.fn();

// The strip's marks are the one part of it a screenshot cannot check: the dot
// is decoration and the state it stands for lives in the tab's accessible name.
// These tests pin the pair — a dot of the right colour and a name a screen
// reader can actually announce.
const tabs: SessionTab[] = [
  { id: "a", label: "First" },
  { id: "b", label: "Second", mark: "waiting" },
  { id: "c", label: "Third", mark: "unread" },
  { id: "d", label: "Fourth", mark: "failed" },
];

function renderStrip(activeId = "a") {
  return render(
    <SessionTabs
      tabs={tabs}
      activeId={activeId}
      onSelect={vi.fn()}
      onClose={vi.fn()}
      onMove={vi.fn()}
    />,
  );
}

const stateName = (name: string, state: string) => t("tabs.withState", { name, state });

describe("the marks on the tab strip", () => {
  it("says the state in the tab's name, not only in its colour", () => {
    renderStrip();

    expect(
      screen.getByRole("tab", { name: stateName("Second", t("switcher.waiting")) }),
    ).toBeTruthy();
    expect(
      screen.getByRole("tab", { name: stateName("Third", t("switcher.unread")) }),
    ).toBeTruthy();
    expect(
      screen.getByRole("tab", { name: stateName("Fourth", t("switcher.failed")) }),
    ).toBeTruthy();
  });

  it("leaves a tab with nothing to say under its own name", () => {
    renderStrip();

    // No aria-label at all: the visible label is the name, unadorned.
    expect(screen.getByRole("tab", { name: "First" })).toBeTruthy();
  });

  it("draws a dot in the state's colour and no dot otherwise", () => {
    renderStrip();

    const dot = (name: string) =>
      screen.getByRole("tab", { name }).querySelector('[aria-hidden="true"]');
    expect(dot(stateName("Second", t("switcher.waiting")))?.className).toContain("bg-kin-orange");
    expect(dot(stateName("Third", t("switcher.unread")))?.className).toContain("bg-kin-green");
    expect(dot(stateName("Fourth", t("switcher.failed")))?.className).toContain("bg-kin-red");
    expect(dot("First")).toBeNull();
  });

  it("keeps the tab clickable under its dot", () => {
    const onSelect = vi.fn();
    render(
      <SessionTabs
        tabs={tabs}
        activeId="a"
        onSelect={onSelect}
        onClose={vi.fn()}
        onMove={vi.fn()}
      />,
    );

    // The circle, not the button: a decoration that swallowed the tap would
    // still pass a test that clicked the text beside it.
    const tab = screen.getByRole("tab", { name: stateName("Second", t("switcher.waiting")) });
    fireEvent.click(tab.querySelector('[aria-hidden="true"]') as HTMLElement);
    expect(onSelect).toHaveBeenCalledWith("b");
  });

  it("still offers the close control for a marked tab", () => {
    renderStrip();

    expect(screen.getByRole("button", { name: t("tabs.close", { name: "Second" }) })).toBeTruthy();
  });
});
