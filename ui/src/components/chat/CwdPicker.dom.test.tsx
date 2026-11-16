// @vitest-environment jsdom
import type { ComponentProps } from "react";
import { beforeEach, describe, expect, it, vi } from "vitest";
import { fireEvent, render, screen, waitFor } from "@testing-library/react";
import userEvent from "@testing-library/user-event";
import { setLocale } from "../../i18n";
import { useAppStore } from "../../store/appStore";
import CwdPicker from "./CwdPicker";

/**
 * C1b2: the composer's working-directory row. Every action is the shared
 * `Button` facade, native vs browse is still `cwdPickerMode`'s decision, and the
 * hover card keeps its documented portal exception (it must not take focus,
 * which a `Popover` would).
 */

const api = vi.hoisted(() => ({
  recentCwds: vi.fn(),
  machineDirs: vi.fn(),
  machineRepoBranches: vi.fn(),
  prepareMachineRepo: vi.fn(),
}));

const desktop = vi.hoisted(() => ({
  isDesktop: false,
  pickDirectory: vi.fn(),
}));

vi.mock("../../api/client", async (importOriginal) => {
  const actual = await importOriginal<typeof import("../../api/client")>();
  return {
    ...actual,
    recentCwds: api.recentCwds,
    machineDirs: api.machineDirs,
    machineRepoBranches: api.machineRepoBranches,
    prepareMachineRepo: api.prepareMachineRepo,
  };
});

vi.mock("../../lib/desktop", () => ({
  isKinDesktop: () => desktop.isDesktop,
  pickDirectory: desktop.pickDirectory,
}));

/* The phone shape keeps these tests on the `Sheet`; the wide test below pins
 * the anchored `Popover`, which needs no platform stubs. */
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

const CWD = "/Users/me/proj";

function setup(props: Partial<ComponentProps<typeof CwdPicker>> = {}, wide = false) {
  viewport(wide);
  const onChange = vi.fn();
  const view = render(<CwdPicker cwd={CWD} onChange={onChange} {...props} />);
  return { onChange, ...view };
}

beforeEach(() => {
  setLocale("en");
  viewport(false);
  api.recentCwds.mockReset().mockResolvedValue(["/Users/me/other"]);
  api.machineDirs.mockReset().mockResolvedValue({
    path: "",
    roots: ["/Users/me"],
    parent: "",
    entries: [],
    truncated: false,
  });
  desktop.isDesktop = false;
  desktop.pickDirectory.mockReset();
});

describe("the cwd row", () => {
  it("the cwd chip is one quiet facade button that opens the browser", async () => {
    setup({ device: "macbook" });

    const chip = screen.getByRole("button", {
      name: "Working directory: /Users/me/proj",
    });
    expect(chip.className).toContain("kin-btn");
    expect(chip.className).not.toContain("kin-btn-primary");
    expect(chip.querySelector("svg")).not.toBeNull();
    expect(chip.textContent).toContain("proj");

    await userEvent.click(chip);
    expect(await screen.findByRole("dialog", { name: "Where to work" })).toBeTruthy();
  });

  it("at Mac widths the browser hangs from the cwd chip", async () => {
    setup({ device: "macbook" }, true);

    const chip = screen.getByRole("button", {
      name: "Working directory: /Users/me/proj",
    });
    expect(chip.getAttribute("aria-haspopup")).toBe("dialog");
    expect(chip.getAttribute("aria-expanded")).toBe("false");

    await userEvent.click(chip);
    const panel = await screen.findByRole("dialog", { name: "Where to work" });
    // Anchored, not centered: the shared panel is portaled next to the chip,
    // and the chip says so while it is open.
    expect(panel.tagName).toBe("DIV");
    expect(panel.className).toContain("fixed");
    expect(chip.getAttribute("aria-expanded")).toBe("true");

    await userEvent.keyboard("{Escape}");
    await waitFor(() => expect(screen.queryByRole("dialog", { name: "Where to work" })).toBeNull());
    expect(document.activeElement).toBe(chip);
  });

  it("browse and edit are facade buttons and still do their jobs", async () => {
    const { onChange, rerender } = setup({ device: "macbook" });

    expect(screen.getByRole("button", { name: "Browse" }).className).toContain("kin-btn");
    expect(screen.getByRole("button", { name: "Edit" }).className).toContain("kin-btn");

    await userEvent.click(screen.getByRole("button", { name: "Edit" }));
    const input = screen.getByRole("combobox");
    await userEvent.clear(input);
    await userEvent.type(input, "/typed/path{Enter}");
    expect(onChange).toHaveBeenCalledWith("/typed/path");

    rerender(<CwdPicker cwd="/typed/path" onChange={onChange} device="macbook" />);

    // Escape restores the previous path: nothing is committed and the field
    // closes with the current value back in the draft.
    await userEvent.click(screen.getByRole("button", { name: "Edit" }));
    const again = screen.getByRole("combobox") as HTMLInputElement;
    expect(again.value).toBe("/typed/path");
    await userEvent.clear(again);
    await userEvent.type(again, "/discarded{Escape}");
    expect(onChange).not.toHaveBeenCalledWith("/discarded");
    expect(screen.queryByRole("combobox")).toBeNull();

    await userEvent.click(screen.getByRole("button", { name: "Edit" }));
    expect((screen.getByRole("combobox") as HTMLInputElement).value).toBe("/typed/path");
  });

  it("in native mode the browse action still calls the folder dialog", async () => {
    desktop.isDesktop = true;
    desktop.pickDirectory.mockResolvedValue("/picked/dir");
    const { onChange } = setup();

    const browse = screen.getByRole("button", { name: "Browse" });
    expect(browse.className).toContain("kin-btn");

    await userEvent.click(browse);
    await waitFor(() => expect(onChange).toHaveBeenCalledWith("/picked/dir"));
    expect(desktop.pickDirectory).toHaveBeenCalled();
  });

  it("the path hover card copies the full path and Escape dismisses it", async () => {
    const pushToast = vi.fn();
    useAppStore.setState({ pushToast });
    const writeText = vi.fn().mockResolvedValue(undefined);
    Object.defineProperty(navigator, "clipboard", {
      value: { writeText },
      configurable: true,
    });

    setup({ device: "macbook" });

    const tag = screen.getByRole("button", {
      name: "Working directory: /Users/me/proj. Copy",
    });
    // The one control in this row that is not a `Button`, so it states its own
    // touch floor: 44px on a phone, the desktop row's own height at `sm` up.
    expect(tag.className).toContain("min-h-11");
    expect(tag.className).toContain("sm:min-h-0");
    await userEvent.hover(tag);

    const copy = await screen.findByRole("button", { name: "Copy" });
    expect(copy.className).toContain("kin-btn");

    await userEvent.click(copy);
    expect(writeText).toHaveBeenCalledWith(CWD);
    expect(pushToast).toHaveBeenCalledWith("Path copied", "info");

    fireEvent.keyDown(tag, { key: "Escape" });
    await waitFor(() => expect(screen.queryByRole("button", { name: "Copy" })).toBeNull());
    expect(screen.queryByRole("dialog")).toBeNull();
  });
});
