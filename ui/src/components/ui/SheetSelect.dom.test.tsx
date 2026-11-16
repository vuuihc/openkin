// @vitest-environment jsdom
import { useEffect, useRef, type RefObject } from "react";
import { beforeEach, describe, expect, it, vi } from "vitest";
import { render, screen } from "@testing-library/react";
import userEvent from "@testing-library/user-event";
import { setLocale } from "../../i18n";
import SheetSelect from "./SheetSelect";

/**
 * KIN-CONTINUE-001, step 5: the small choice control has one shape per width.
 *
 * On a phone the chip opens the console's action sheet. On a Mac the same chip
 * used to open that sheet in the middle of a desktop window, over the composer
 * it was describing; these tests pin the desktop surface to an anchored menu
 * and keep the sheet on the phone.
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
  render(<SheetSelect label="Role" value={value} options={OPTIONS} onChange={onChange} />);
  return { onChange, chip: screen.getByRole("button", { name: /^Role/ }) };
}

/**
 * A caller's ref, created the way a parent creates one. The component reads it
 * as the trigger ref, so the node it points at is the chip the reader clicks.
 */
function RefHarness({ capture }: { capture: (ref: RefObject<HTMLButtonElement | null>) => void }) {
  const buttonRef = useRef<HTMLButtonElement | null>(null);
  useEffect(() => capture(buttonRef), [capture, buttonRef]);
  return (
    <SheetSelect
      label="Role"
      value=""
      options={OPTIONS}
      onChange={() => {}}
      buttonRef={buttonRef}
    />
  );
}

beforeEach(() => {
  setLocale("en");
});

describe("the sheet select on a Mac", () => {
  it("opens an anchored menu instead of a phone action sheet", async () => {
    const { chip } = setup(true);
    await userEvent.click(chip);

    const menu = screen.getByRole("menu", { name: "Role" });
    // The menu's panel is now the shared `Popover` layer.
    // Portaled and measured from the viewport: the composer's `overflow-x-auto`
    // strip clipped an absolutely positioned panel to its own height.
    expect(menu.closest(".fixed")).toBeTruthy();
    expect(document.body.contains(menu)).toBe(true);
    expect(menu.parentElement?.parentElement).toBe(document.body);
    expect(document.querySelector("[data-kin-sheet]")).toBeNull();
    // The current value is checked, and opening lands on the first enabled row.
    const current = screen.getByRole("menuitemradio", { name: "No role" });
    expect(current.getAttribute("aria-checked")).toBe("true");
    expect(document.activeElement).toBe(current);
  });

  it("draws its menu through the shared popover layer", async () => {
    const { chip } = setup(true);
    await userEvent.click(chip);

    // Same layer as every other popover: a viewport-fixed dialog named by the
    // control's label, portaled to <body>, holding the menu.
    const panel = screen.getByRole("dialog", { name: "Role" });
    expect(panel.className).toContain("fixed");
    expect(panel.parentElement).toBe(document.body);
    expect(panel.querySelector('[role="menu"]')).toBeTruthy();
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

  it("sets the external button ref to the trigger node", () => {
    viewport(true);
    const captured: { ref: RefObject<HTMLButtonElement | null> | null } = { ref: null };
    render(
      <RefHarness
        capture={(ref) => {
          captured.ref = ref;
        }}
      />,
    );

    const chip = screen.getByRole("button", { name: /^Role/ });
    expect(chip).toBeInstanceOf(HTMLButtonElement);
    expect(captured.ref?.current).toBe(chip);
  });

  it("closes on Escape without changing the value", async () => {
    const { onChange, chip } = setup(true, "reviewer");
    await userEvent.click(chip);
    await userEvent.keyboard("{Escape}");

    expect(onChange).not.toHaveBeenCalled();
    expect(screen.queryByRole("menu")).toBeNull();
    expect(document.activeElement).toBe(chip);
  });

  it("moves keyboard focus back to an empty-id default option", async () => {
    const { chip } = setup(true);
    await userEvent.click(chip);

    const noRole = screen.getByRole("menuitemradio", { name: "No role" });
    await userEvent.keyboard("{ArrowDown}");
    expect(document.activeElement).toBe(screen.getByRole("menuitemradio", { name: "Reviewer" }));

    await userEvent.keyboard("{ArrowUp}");
    expect(document.activeElement).toBe(noRole);

    await userEvent.keyboard("{End}");
    expect(document.activeElement).toBe(screen.getByRole("menuitemradio", { name: "Writer" }));

    await userEvent.keyboard("{ArrowDown}");
    expect(document.activeElement).toBe(noRole);
  });
});

describe("the sheet select on a phone", () => {
  it("keeps the bottom sheet and mounts no desktop menu", async () => {
    const { chip } = setup(false);
    await userEvent.click(chip);

    expect(chip.getAttribute("aria-expanded")).toBe("true");
    const sheet = screen.getByRole("dialog", { name: "Role" });
    expect(sheet).toBeTruthy();
    expect(screen.getByRole("button", { name: "Reviewer" })).toBeTruthy();
    expect(screen.queryByRole("menu")).toBeNull();
  });

  it("keeps the trigger focused after choosing an option", async () => {
    const { onChange, chip } = setup(false);
    await userEvent.click(chip);
    expect(screen.getByRole("dialog", { name: "Role" })).toBeTruthy();

    await userEvent.click(screen.getByRole("button", { name: "Reviewer" }));

    expect(onChange).toHaveBeenCalledWith("reviewer");
    expect(screen.queryByRole("dialog")).toBeNull();
    // The sheet restores focus to whoever opened it; with React 19's ref
    // cleanup timing, the chip must still be that node when the row answers.
    expect(document.activeElement).toBe(chip);
  });
});
