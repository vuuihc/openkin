// @vitest-environment jsdom
import { beforeEach, describe, expect, it, vi } from "vitest";
import { render, screen, waitFor } from "@testing-library/react";
import userEvent from "@testing-library/user-event";
import { setLocale } from "../../i18n";
import PermissionModePicker from "./PermissionModePicker";

/**
 * KIN-CONTINUE-001, step 5: the permission chip opens a menu on a Mac and the
 * phone's bottom sheet on a phone.
 *
 * The Mac side used to open an Ionic action sheet — an iPhone surface in the
 * middle of a desktop window, over the composer that was being configured.
 * These tests pin the surface itself: `role="menu"` and no phone sheet
 * at desktop width, the sheet still on a phone, Escape closing without
 * answering, and focus returning to the chip.
 */

function viewport(wide: boolean) {
  vi.stubGlobal("matchMedia", (query: string) => ({
    matches: query === "(min-width: 768px)" ? wide : false,
    media: query,
    onchange: null,
    addEventListener: vi.fn(),
    removeEventListener: vi.fn(),
    addListener: vi.fn(),
    removeListener: vi.fn(),
    dispatchEvent: vi.fn(),
  }));
}

function setViewport(width: number) {
  Object.defineProperty(window, "innerWidth", { configurable: true, value: width });
}

function setup(wide: boolean) {
  viewport(wide);
  setViewport(wide ? 1280 : 390);
  const onChange = vi.fn();
  render(<PermissionModePicker value="default" compact onChange={onChange} />);
  return { onChange, chip: screen.getByRole("button", { name: /^Permission/ }) };
}

const row = (name: RegExp) => screen.getByRole("menuitemradio", { name });

beforeEach(() => {
  setLocale("en");
});

describe("the permission picker", () => {
  it("opens an anchored menu on a Mac, not a phone action sheet", async () => {
    const { chip } = setup(true);
    await userEvent.click(chip);

    const menu = screen.getByRole("menu", { name: "Permissions" });
    // Portaled and measured from the viewport: the composer's `overflow-x-auto`
    // control row made `overflow-y` auto as well, so an absolutely positioned
    // menu was clipped to the ~30px strip and painted nothing at all. The
    // portal, the measurement and the panel shape are the shared `Popover`
    // layer's now, so they are asserted on the layer that contains the menu.
    const layer = menu.closest<HTMLElement>('[role="dialog"]');
    expect(layer).not.toBeNull();
    expect(layer!.className).toContain("fixed");
    expect(layer!.parentElement).toBe(document.body);
    expect(document.querySelector("[data-kin-sheet]")).toBeNull();
    // #3: the same viewport measurement as the model and agent panels — the
    // menu stays inside the 1280px window and uses one side of the chip.
    const left = Number.parseFloat(layer!.style.left);
    const width = Number.parseFloat(layer!.style.width);
    expect(width).toBe(288);
    expect(left).toBeGreaterThanOrEqual(8);
    expect(left + width).toBeLessThanOrEqual(1280 - 8);
    expect(Boolean(layer!.style.top) !== Boolean(layer!.style.bottom)).toBe(true);
    // The consequences travel with the names: "ask" is only the safe choice if
    // the row says so.
    expect(screen.getByRole("menuitemradio", { name: /YOLO.*trusted/i })).toBeTruthy();
    // The panel mounts a layout effect after the click, so focus has to wait
    // for the measured anchor; without that it stays on the chip and the
    // first arrow key has nothing to move from.
    expect(document.activeElement?.getAttribute("role")).toBe("menuitemradio");
    expect(document.activeElement?.getAttribute("aria-checked")).toBe("true");
  });

  it("opens on the current mode, not the first one", async () => {
    viewport(true);
    setViewport(1280);
    const onChange = vi.fn();
    render(<PermissionModePicker value="yolo" compact onChange={onChange} />);
    const chip = screen.getByRole("button", { name: /^Permission/ });
    await userEvent.click(chip);

    // A session already in YOLO opens on YOLO — the row that is set — so the
    // next arrow key moves from the current mode (the ring wraps to Ask)
    // instead of starting at the top of the list and reporting a mode the
    // session is not in.
    await waitFor(() => expect(document.activeElement).toBe(row(/^YOLO/)));
    expect(document.activeElement?.getAttribute("aria-checked")).toBe("true");
    await userEvent.keyboard("{ArrowDown}");
    expect(document.activeElement).toBe(row(/^Ask/));
  });

  it("answers once, closes, and returns focus to the chip", async () => {
    const { onChange, chip } = setup(true);
    await userEvent.click(chip);
    await userEvent.click(screen.getByRole("menuitemradio", { name: /YOLO/ }));

    expect(onChange).toHaveBeenCalledTimes(1);
    expect(onChange).toHaveBeenCalledWith("yolo");
    expect(screen.queryByRole("menu")).toBeNull();
    expect(document.activeElement).toBe(chip);
  });

  it("closes on Escape without changing the mode", async () => {
    const { onChange, chip } = setup(true);
    await userEvent.click(chip);
    await userEvent.keyboard("{Escape}");

    expect(onChange).not.toHaveBeenCalled();
    expect(screen.queryByRole("menu")).toBeNull();
    expect(document.activeElement).toBe(chip);
  });

  it("keeps the bottom sheet on a phone", async () => {
    const { chip } = setup(false);
    await userEvent.click(chip);

    expect(chip.getAttribute("aria-expanded")).toBe("true");
    expect(screen.getByRole("dialog", { name: "Permissions" })).toBeTruthy();
    expect(screen.queryByRole("menu")).toBeNull();
  });

  it("arrow keys move through the modes and wrap", async () => {
    const { chip } = setup(true);
    await userEvent.click(chip);
    expect(document.activeElement).toBe(row(/^Ask/));

    await userEvent.keyboard("{ArrowDown}");
    expect(document.activeElement).toBe(row(/^Auto-edit/));

    await userEvent.keyboard("{ArrowDown}");
    expect(document.activeElement).toBe(row(/^YOLO/));

    // Off the last row and back to the top: three modes are a ring, not a list
    // with a dead end.
    await userEvent.keyboard("{ArrowDown}");
    expect(document.activeElement).toBe(row(/^Ask/));

    await userEvent.keyboard("{ArrowUp}");
    expect(document.activeElement).toBe(row(/^YOLO/));
  });

  it("Home and End jump to the first and last mode", async () => {
    const { chip } = setup(true);
    await userEvent.click(chip);

    await userEvent.keyboard("{End}");
    expect(document.activeElement).toBe(row(/^YOLO/));

    await userEvent.keyboard("{Home}");
    expect(document.activeElement).toBe(row(/^Ask/));
  });

  it("typing a letter lands on the mode that starts with it", async () => {
    const { onChange, chip } = setup(true);
    await userEvent.click(chip);

    await userEvent.keyboard("y");

    expect(document.activeElement).toBe(row(/^YOLO/));
    expect(onChange).not.toHaveBeenCalled();
  });

  it("each mode row keeps its consequence line in its accessible name", async () => {
    const { chip } = setup(true);
    await userEvent.click(chip);

    // The consequence is part of what the row is called, so it is read out
    // with the mode instead of sitting in a tooltip the keyboard never reaches.
    expect(row(/^Ask.*Ask before risky tools/)).toBeTruthy();
    expect(row(/^Auto-edit.*Auto-accept file edits/)).toBeTruthy();
    expect(row(/^YOLO.*trusted/)).toBeTruthy();
  });

  it("lays the label and chevron out on the facade's inner span", () => {
    const { chip } = setup(true);

    // Astryx's `Button` wraps its children in two spans of its own, so the row's
    // flex layout and the shrink floor have to sit inside those wrappers; left
    // on the `<button>` the label and chevron stack and the label never
    // truncates. jsdom has no layout, so this pins the class contract, as the
    // branch and dispatch chips do.
    expect(chip.classList.contains("[&>span]:min-w-0")).toBe(true);
    expect(chip.classList.contains("[&>span>span]:min-w-0")).toBe(true);

    const inner = chip.querySelector<HTMLElement>("span.inline-flex.min-w-0.items-center");
    expect(inner).not.toBeNull();
    const label = inner!.querySelector<HTMLElement>("span.truncate");
    expect(label?.textContent).toBeTruthy();
    // One inner row holds both children in order: the label shrinks, the
    // chevron keeps its width.
    const chevron = inner!.querySelector("svg");
    expect(chevron).not.toBeNull();
    expect(label!.nextElementSibling).toBe(chevron);
  });

  it("a locked chip opens nothing", async () => {
    const onChange = vi.fn();
    render(<PermissionModePicker value="default" compact locked onChange={onChange} />);
    const chip = screen.getByRole("button", { name: /^Permission/ });
    expect(chip.hasAttribute("disabled")).toBe(true);

    await userEvent.click(chip);

    expect(screen.queryByRole("menu")).toBeNull();
    expect(screen.queryByRole("dialog")).toBeNull();
    expect(onChange).not.toHaveBeenCalled();
  });

  it("the menu closes when its pane is no longer the active one", async () => {
    const onChange = vi.fn();
    const { rerender } = render(
      <PermissionModePicker value="default" compact active onChange={onChange} />,
    );
    await userEvent.click(screen.getByRole("button", { name: /^Permission/ }));
    expect(screen.getByRole("menu", { name: "Permissions" })).toBeTruthy();

    // The menu portals out of the pane's hidden subtree; a pane that goes off
    // screen must take its menu with it instead of floating over the next
    // conversation and owning its keyboard.
    rerender(<PermissionModePicker value="default" compact active={false} onChange={onChange} />);

    expect(screen.queryByRole("menu")).toBeNull();
    expect(screen.queryByRole("dialog")).toBeNull();
  });
});
