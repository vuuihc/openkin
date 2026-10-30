// @vitest-environment jsdom
import { beforeEach, describe, expect, it, vi } from "vitest";
import { render, screen } from "@testing-library/react";
import userEvent from "@testing-library/user-event";
import { setLocale } from "../../i18n";
import SheetSelect from "./SheetSelect";

/**
 * KIN-CONTINUE-001, step 5: the small choice control has one shape per width.
 *
 * On a phone the chip opens Ionic's action sheet — the platform's own
 * interaction. On a Mac the same chip used to open that sheet in the middle of
 * a desktop window, over the composer it was describing; these tests pin the
 * desktop surface to an anchored menu and keep the sheet on the phone.
 */

const OPTIONS = [
  { id: "", label: "No role" },
  { id: "reviewer", label: "Reviewer" },
  { id: "writer", label: "Writer", destructive: true },
];

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

function setup(wide: boolean, value = "") {
  viewport(wide);
  const onChange = vi.fn();
  render(
    <SheetSelect label="Role" value={value} options={OPTIONS} onChange={onChange} />,
  );
  return { onChange, chip: screen.getByRole("button", { name: /^Role/ }) };
}

beforeEach(() => {
  setLocale("en");
});

describe("the sheet select on a Mac", () => {
  it("opens an anchored menu instead of a phone action sheet", async () => {
    const { chip } = setup(true);
    await userEvent.click(chip);

    const menu = screen.getByRole("menu", { name: "Role" });
    // Portaled and measured from the viewport: the composer's `overflow-x-auto`
    // strip clipped an absolutely positioned panel to its own height.
    expect(menu.className).toContain("fixed");
    expect(menu.parentElement).toBe(document.body);
    expect(document.querySelector("ion-action-sheet")).toBeNull();
    // The current value is checked, and opening lands on it so the next arrow
    // is relative to what is set.
    const current = screen.getByRole("menuitemradio", { name: "No role" });
    expect(current.getAttribute("aria-checked")).toBe("true");
    expect(document.activeElement).toBe(current);
  });

  it("answers once, closes, and returns focus to the chip", async () => {
    const { onChange, chip } = setup(true);
    await userEvent.click(chip);
    await userEvent.click(screen.getByRole("menuitemradio", { name: "Reviewer" }));

    expect(onChange).toHaveBeenCalledTimes(1);
    expect(onChange).toHaveBeenCalledWith("reviewer");
    expect(screen.queryByRole("menu")).toBeNull();
    expect(document.activeElement).toBe(chip);
  });

  it("closes on Escape without changing the value", async () => {
    const { onChange, chip } = setup(true, "reviewer");
    await userEvent.click(chip);
    await userEvent.keyboard("{Escape}");

    expect(onChange).not.toHaveBeenCalled();
    expect(screen.queryByRole("menu")).toBeNull();
    expect(document.activeElement).toBe(chip);
  });
});

describe("the sheet select on a phone", () => {
  it("keeps the bottom sheet and mounts no desktop menu", async () => {
    const { chip } = setup(false);
    await userEvent.click(chip);

    // The Ionic host exists whether or not it is open, so the host alone
    // proves nothing: the chip has to have asked it to open.
    expect(chip.getAttribute("aria-expanded")).toBe("true");
    expect(document.querySelector("ion-action-sheet")).not.toBeNull();
    expect(screen.queryByRole("menu")).toBeNull();
  });
});
