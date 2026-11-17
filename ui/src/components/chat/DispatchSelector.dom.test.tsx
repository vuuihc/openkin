// @vitest-environment jsdom
import { useState } from "react";
import { beforeEach, describe, expect, it, vi } from "vitest";
import { act, render, screen, waitFor, within } from "@testing-library/react";
import userEvent from "@testing-library/user-event";
import { setLocale } from "../../i18n";
import { resetLayerDismissers } from "../../lib/backStack";
import Sheet from "../mobile/Sheet";
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

/**
 * The answer `matchMedia` gives about this device.
 *
 * jsdom has none, and every viewport hook's fallback is the shipped desktop
 * shape, so a test that says nothing about the pointer is a Mac with a mouse.
 * The stub spells out the two queries this tree asks — pointer kind and width
 * — so a coarse-pointer test cannot pass by inheriting a width answer.
 */
function setMedia({ coarse = false }: { coarse?: boolean } = {}) {
  vi.stubGlobal("matchMedia", (query: string) => ({
    // The default is the 390px phone these tests are about: a width answer of
    // `true` would make `Sheet` auto-close the moment it mounts.
    matches: query.includes("pointer: coarse") ? coarse : false,
    media: query,
    onchange: null,
    addEventListener: () => {},
    removeEventListener: () => {},
    addListener: () => {},
    removeListener: () => {},
    dispatchEvent: () => false,
  }));
}

function setup() {
  const onChange = vi.fn();
  render(<DispatchSelector value={{}} onChange={onChange} />);
  return { onChange, trigger: screen.getByRole("button", { name: "Dispatch" }) };
}

beforeEach(() => {
  setLocale("en");
  setViewportWidth(1024);
  vi.unstubAllGlobals();
  setMedia();
  resetLayerDismissers();
});

/**
 * The dispatch control where it actually sits on a phone: inside the run
 * settings `Sheet`. Its team field is a `SearchSelect`, whose phone surface is
 * a second `Sheet` portaled out of the dispatch panel — the case the shared
 * `Popover` layer cannot see as its own reach.
 */
function DispatchInRunSettings() {
  const [value, setValue] = useState<DispatchSelection>({});
  const [open, setOpen] = useState(true);
  return (
    <Sheet open={open} onClose={() => setOpen(false)} title="Run settings">
      <DispatchSelector value={value} onChange={setValue} />
    </Sheet>
  );
}

/** A `SearchSelect` phone trigger: the one that opens a sheet, not a listbox. */
function phoneTrigger(name: RegExp): HTMLElement {
  const trigger = screen
    .getAllByRole("button", { name })
    .find((button) => button.getAttribute("aria-haspopup") === "dialog");
  expect(trigger).toBeTruthy();
  return trigger!;
}

async function openDispatchInSheet() {
  render(<DispatchInRunSettings />);
  await userEvent.click(screen.getByRole("button", { name: "Dispatch" }));
  return screen.findByRole("dialog", { name: "Dispatch settings" });
}

describe("the dispatch trigger", () => {
  it("gives the dispatch trigger a 44px tap target on a coarse pointer", async () => {
    // TASTE 11: the size follows the pointer, not the viewport. An iPad is
    // ≥640px wide and still a thumb, so the 44px floor must not be undone by
    // `sm:`. jsdom has no layout, so this pins the class contract; the journey
    // walk and the iPad measurement prove the geometry.
    setMedia({ coarse: true });
    const { trigger } = setup();
    expect(trigger.classList.contains("min-h-11")).toBe(true);
    expect(trigger.classList.contains("min-w-11")).toBe(true);
    expect(trigger.classList.contains("sm:min-h-7")).toBe(false);
    expect(trigger.classList.contains("sm:min-w-0")).toBe(false);
    // The chip is the same layer's trigger: label, popup role and open state
    // must not move with the size.
    expect(trigger.textContent).toBe("Dispatch");
    expect(trigger.getAttribute("aria-haspopup")).toBe("dialog");
    await userEvent.click(trigger);
    const panel = await screen.findByRole("dialog", { name: "Dispatch settings" });
    expect(panel).toBeTruthy();
    expect(trigger.getAttribute("aria-expanded")).toBe("true");
    // The panel's own mode buttons are tap targets on the same surface, so
    // they hold the same floor.
    for (const name of ["Auto", "Manual"]) {
      const button = within(panel).getByRole("button", { name });
      // `!` is part of the contract: the facade's own `sm:` zero-floor
      // variant would win at the iPad's width without it.
      expect(button.className).toContain("min-h-11!");
      expect(button.className).not.toContain("min-h-7");
    }
  });

  it("keeps the compact trigger and mode buttons on a fine pointer", async () => {
    // The Mac shape: a mouse does not need a 44px box, and the run settings
    // panel's row heights were built around the 28px chip. This locks the
    // other half of the pointer contract so a later "always big" fix cannot
    // quietly move every Mac panel.
    setMedia({ coarse: false });
    const { trigger } = setup();
    expect(trigger.classList.contains("min-h-7")).toBe(true);
    expect(trigger.classList.contains("min-w-0")).toBe(true);
    expect(trigger.classList.contains("min-h-11")).toBe(false);
    expect(trigger.classList.contains("min-w-11")).toBe(false);

    await userEvent.click(trigger);
    const panel = await screen.findByRole("dialog", { name: "Dispatch settings" });
    for (const name of ["Auto", "Manual"]) {
      const button = within(panel).getByRole("button", { name });
      expect(button.className).toContain("min-h-7");
      expect(button.className).not.toContain("min-h-11!");
    }
  });

  it("gives the preview toggle the touch floor on a coarse pointer", async () => {
    // A team set is what reveals the toggle. It is a small text link on a Mac
    // and must be a real 44px row on touch.
    setMedia({ coarse: true });
    render(<DispatchSelector value={{ mode: "auto", team: "t1" }} onChange={vi.fn()} />);
    // A configured selection names the mode in the trigger, so the trigger is
    // found by that summary rather than by the empty "Dispatch" label.
    await userEvent.click(screen.getByRole("button", { name: /^Auto/ }));
    const toggle = await screen.findByRole("button", { name: /Show preview/ });
    expect(toggle.className).toContain("min-h-11");
  });
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

  it("keeps the panel alive while a phone option sheet is used inside it", async () => {
    const panel = await openDispatchInSheet();
    const field = phoneTrigger(/^Default team/);
    await userEvent.click(field);

    const options = await screen.findByRole("dialog", { name: "Default team/profile" });
    await userEvent.click(within(options).getByRole("button", { name: /Select a team profile/ }));

    // The option sheet is portaled out of the dispatch layer and is a `Sheet`,
    // not a popover, so the shared layer cannot count its rows as reach. Its
    // pointer-down must not be read as an outside press: the panel and its
    // picker have to survive until the row's click has selected. The field's
    // own sheet is gone; the panel it was opened from is not.
    expect(screen.getByRole("dialog", { name: "Dispatch settings" })).toBe(panel);
    expect(screen.queryByRole("dialog", { name: "Default team/profile" })).toBeNull();
    expect(panel.contains(field)).toBe(true);
  });

  it("spends Escape on the option sheet, then the dispatch panel, then the run settings", async () => {
    await openDispatchInSheet();
    const field = phoneTrigger(/^Default team/);
    await userEvent.click(field);
    await screen.findByRole("dialog", { name: "Default team/profile" });

    await userEvent.keyboard("{Escape}");
    expect(screen.queryByRole("dialog", { name: "Default team/profile" })).toBeNull();
    expect(screen.getByRole("dialog", { name: "Dispatch settings" })).toBeTruthy();
    expect(screen.getByRole("dialog", { name: "Run settings" })).toBeTruthy();
    // Focus returns to the field that opened the sheet, so the panel's own
    // Escape handling still finds the reader inside it.
    expect(document.activeElement).toBe(field);

    // The panel is the layer over the settings now, so it takes the next one.
    await waitFor(() => expect(document.querySelector("[data-sheet-layer]")).toBeTruthy());
    await userEvent.keyboard("{Escape}");
    expect(screen.queryByRole("dialog", { name: "Dispatch settings" })).toBeNull();
    expect(screen.getByRole("dialog", { name: "Run settings" })).toBeTruthy();

    // Only the settings are left, and they still own the last Escape.
    await waitFor(() => expect(document.querySelector("[data-sheet-layer]")).toBeNull());
    await userEvent.keyboard("{Escape}");
    expect(screen.queryByRole("dialog", { name: "Run settings" })).toBeNull();
  });

  it("gives Back to the option sheet, then the dispatch panel, then the run settings", async () => {
    await openDispatchInSheet();
    await userEvent.click(phoneTrigger(/^Default team/));
    await screen.findByRole("dialog", { name: "Default team/profile" });

    // The system Back gesture, as the browser delivers it: the current entry
    // has already become the one below the sheet when `popstate` arrives.
    act(() => {
      window.history.replaceState({}, "");
      window.dispatchEvent(new PopStateEvent("popstate"));
    });
    expect(screen.queryByRole("dialog", { name: "Default team/profile" })).toBeNull();
    expect(screen.getByRole("dialog", { name: "Dispatch settings" })).toBeTruthy();
    expect(screen.getByRole("dialog", { name: "Run settings" })).toBeTruthy();

    // The panel registers as the settings' top layer again once the option
    // sheet is gone: the next Back closes it, not the settings behind it.
    await waitFor(() => expect(document.querySelector("[data-sheet-layer]")).toBeTruthy());
    act(() => {
      window.history.replaceState({}, "");
      window.dispatchEvent(new PopStateEvent("popstate"));
    });
    expect(screen.queryByRole("dialog", { name: "Dispatch settings" })).toBeNull();
    expect(screen.getByRole("dialog", { name: "Run settings" })).toBeTruthy();

    act(() => {
      window.history.replaceState({}, "");
      window.dispatchEvent(new PopStateEvent("popstate"));
    });
    expect(screen.queryByRole("dialog", { name: "Run settings" })).toBeNull();
  });
});
