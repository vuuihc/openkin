// @vitest-environment jsdom
import { beforeEach, describe, expect, it, vi } from "vitest";
import { render, screen } from "@testing-library/react";
import userEvent from "@testing-library/user-event";
import { setLocale } from "../../i18n";
import PermissionModePicker from "./PermissionModePicker";

/**
 * KIN-CONTINUE-001, step 5: the permission chip opens a menu on a Mac and the
 * phone's bottom sheet on a phone.
 *
 * The Mac side used to open an Ionic action sheet — an iPhone surface in the
 * middle of a desktop window, over the composer that was being configured.
 * These tests pin the surface itself: `role="menu"` and no `ion-action-sheet`
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
    // menu was clipped to the ~30px strip and painted nothing at all.
    expect(menu.className).toContain("fixed");
    expect(menu.parentElement).toBe(document.body);
    expect(document.querySelector("ion-action-sheet")).toBeNull();
    // #3: the same viewport measurement as the model and agent panels — the
    // menu stays inside the 1280px window and uses one side of the chip.
    const left = Number.parseFloat(menu.style.left);
    const width = Number.parseFloat(menu.style.width);
    expect(left).toBeGreaterThanOrEqual(8);
    expect(left + width).toBeLessThanOrEqual(1280 - 8);
    expect(Boolean(menu.style.top) !== Boolean(menu.style.bottom)).toBe(true);
    // The consequences travel with the names: "ask" is only the safe choice if
    // the row says so.
    expect(screen.getByRole("menuitemradio", { name: /YOLO.*trusted/i })).toBeTruthy();
    // The panel mounts a layout effect after the click, so focus has to wait
    // for the measured anchor; without that it stays on the chip and the
    // first arrow key has nothing to move from.
    expect(document.activeElement?.getAttribute("role")).toBe("menuitemradio");
    expect(document.activeElement?.getAttribute("aria-checked")).toBe("true");
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

    // The host is mounted closed as well; the expanded chip is what says the
    // sheet was actually asked to open.
    expect(chip.getAttribute("aria-expanded")).toBe("true");
    expect(document.querySelector("ion-action-sheet")).not.toBeNull();
    expect(screen.queryByRole("menu")).toBeNull();
  });
});
