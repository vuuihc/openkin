// @vitest-environment jsdom
import { useState } from "react";
import { beforeEach, describe, expect, it, vi } from "vitest";
import { render, screen, within } from "@testing-library/react";
import userEvent from "@testing-library/user-event";
import { setLocale } from "../../i18n";
import { DispatchSelector, type DispatchSelection } from "./DispatchSelector";

/**
 * #1: the composer's control row is an `overflow-x-auto` strip, and CSS makes
 * that `overflow-y: auto` too, so the dispatch panel used to be clipped by the
 * strip it was absolutely positioned in. It is portaled to <body> and placed
 * from the viewport instead. These tests pin that contract: the panel is a body
 * child measured against the viewport (including at 390px), while the portal
 * keeps inside-click and Escape behaviour intact.
 */
vi.mock("../../api/client", () => ({
  getRoutingOptions: vi.fn(async () => ({
    agents: [],
    providers: [],
    teams: [],
    defaults: {
      enabled: false,
      default_team: "",
      objective: "balanced",
      max_attempts_per_step: 0,
      terminal_limit_policy: "",
      manual_fallback: false,
    },
  })),
  getRoutingPreview: vi.fn(async () => ({ blocked: false, phases: [] })),
}));

function setViewportWidth(width: number) {
  Object.defineProperty(window, "innerWidth", { configurable: true, value: width });
}

function setup() {
  const onChange = vi.fn();
  render(<DispatchSelector value={{}} onChange={onChange} />);
  return { onChange, trigger: screen.getByRole("button", { name: "Dispatch" }) };
}

beforeEach(() => {
  setLocale("en");
  setViewportWidth(1024);
});

describe("the dispatch panel", () => {
  it("is portaled out of the composer strip and measured from the viewport", async () => {
    const { trigger } = setup();
    await userEvent.click(trigger);

    const panel = await screen.findByRole("dialog", { name: "Dispatch settings" });
    // Portaled: not inside the strip that used to clip it.
    expect(panel.parentElement).toBe(document.body);
    expect(panel.className).toContain("fixed");
    expect(panel.style.width).toBe("320px");
    expect(panel.style.maxHeight).toBe("360px");
    // The hook flips a panel that does not fit above the trigger; jsdom reports
    // a zero rect, so the stable contract here is "one side, not both".
    expect(Boolean(panel.style.top) !== Boolean(panel.style.bottom)).toBe(true);
  });

  it("stays inside a 390px viewport", async () => {
    setViewportWidth(390);
    const { trigger } = setup();
    await userEvent.click(trigger);

    const panel = await screen.findByRole("dialog", { name: "Dispatch settings" });
    const left = Number.parseFloat(panel.style.left);
    const width = Number.parseFloat(panel.style.width);
    expect(left).toBeGreaterThanOrEqual(8);
    expect(left + width).toBeLessThanOrEqual(390 - 8);
  });

  it("Escape closes the panel and returns focus to the trigger", async () => {
    const { trigger } = setup();
    await userEvent.click(trigger);
    await screen.findByRole("dialog", { name: "Dispatch settings" });

    await userEvent.keyboard("{Escape}");
    expect(screen.queryByRole("dialog")).toBeNull();
    expect(document.activeElement).toBe(trigger);
  });

  it("does not treat a click inside the portal as an outside click", async () => {
    const { onChange, trigger } = setup();
    await userEvent.click(trigger);
    const panel = await screen.findByRole("dialog", { name: "Dispatch settings" });

    await userEvent.click(screen.getByRole("button", { name: "Manual" }));
    expect(onChange).toHaveBeenCalledWith({ mode: "manual" });
    expect(screen.getByRole("dialog", { name: "Dispatch settings" })).toBe(panel);
  });

  it("Tab stays inside the panel while it is open", async () => {
    const { trigger } = setup();
    await userEvent.click(trigger);
    const panel = await screen.findByRole("dialog", { name: "Dispatch settings" });

    // The panel is portaled out of the strip, so it is not the next stop after
    // the trigger: Tab has to be contained by the layer, not by document order.
    for (let press = 0; press < 6; press += 1) {
      await userEvent.tab();
      expect(panel.contains(document.activeElement)).toBe(true);
    }
  });

  it("the mode buttons report the chosen mode through aria-pressed", async () => {
    function Stateful() {
      const [value, setValue] = useState<DispatchSelection>({});
      return <DispatchSelector value={value} onChange={setValue} />;
    }
    render(<Stateful />);
    await userEvent.click(screen.getByRole("button", { name: "Dispatch" }));
    const panel = await screen.findByRole("dialog", { name: "Dispatch settings" });

    // The fill alone is a colour; `aria-pressed` is what says which of the two
    // modes is on to a reader who cannot see it.
    expect(within(panel).getByRole("button", { name: "Auto" }).getAttribute("aria-pressed")).toBe(
      "true",
    );
    expect(within(panel).getByRole("button", { name: "Manual" }).getAttribute("aria-pressed")).toBe(
      "false",
    );

    await userEvent.click(within(panel).getByRole("button", { name: "Manual" }));

    expect(within(panel).getByRole("button", { name: "Manual" }).getAttribute("aria-pressed")).toBe(
      "true",
    );
    expect(within(panel).getByRole("button", { name: "Auto" }).getAttribute("aria-pressed")).toBe(
      "false",
    );
  });
});
