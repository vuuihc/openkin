// @vitest-environment jsdom
import { beforeEach, describe, expect, it, vi } from "vitest";
import { render, screen } from "@testing-library/react";
import userEvent from "@testing-library/user-event";
import type { ComponentProps } from "react";
import { setLocale } from "../../i18n";
import type { Machine } from "../../lib/devices";
import MachinePicker from "./MachinePicker";

/**
 * Which machine runs the work, through the console's own picker.
 *
 * The route row used to hold a native `<select>`, which on iOS opens a system
 * wheel and ignores the console's tokens. What matters here is the contract
 * with the page: "this machine" is the empty id, a missing machine is named but
 * is not offered as a choice, and an offline machine still appears — reading as
 * offline rather than silently vanishing.
 */

const MACHINES: Machine[] = [
  { id: "", label: "This Mac", isSelf: true, online: true, roots: [], agents: [] },
  { id: "macbook", label: "MacBook", isSelf: false, online: true, roots: [], agents: [] },
  { id: "nas", label: "NAS", isSelf: false, online: false, roots: [], agents: [] },
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

function setup(wide = true, props: Partial<ComponentProps<typeof MachinePicker>> = {}) {
  viewport(wide);
  const onChange = vi.fn();
  const { rerender } = render(
    <MachinePicker machines={MACHINES} value={null} onChange={onChange} {...props} />,
  );
  return { onChange, rerender };
}

beforeEach(() => {
  setLocale("en");
});

describe("the machine picker", () => {
  it("offers this machine first, then the machines work can be sent to", async () => {
    setup();
    await userEvent.click(screen.getByRole("button", { name: /^Machine/ }));

    const rows = screen.getAllByRole("menuitemradio").map((row) => row.textContent);
    expect(rows).toEqual(["This machine", "MacBook", "NAS · offline"]);
    expect(
      screen.getByRole("menuitemradio", { name: "This machine" }).getAttribute("aria-checked"),
    ).toBe("true");
  });

  it("reports a remote machine by id", async () => {
    const { onChange } = setup();
    await userEvent.click(screen.getByRole("button", { name: /^Machine/ }));
    await userEvent.click(screen.getByRole("menuitemradio", { name: "MacBook" }));

    expect(onChange).toHaveBeenCalledWith("macbook");
  });

  it("reports this machine as the empty id, not its name", async () => {
    const { onChange } = setup(true, { value: "macbook" });
    await userEvent.click(screen.getByRole("button", { name: /^Machine/ }));
    await userEvent.click(screen.getByRole("menuitemradio", { name: "This machine" }));

    expect(onChange).toHaveBeenCalledWith(null);
  });

  it("names a machine that has gone away without offering it as a choice", async () => {
    setup(true, { value: null, missing: "Gone Book" });
    const chip = screen.getByRole("button", {
      name: /Gone Book is no longer in the machine list/,
    });
    expect(chip).toBeTruthy();

    await userEvent.click(chip);
    expect(screen.queryByRole("menuitemradio", { name: /Gone Book/ })).toBeNull();
    expect(screen.getAllByRole("menuitemradio")).toHaveLength(MACHINES.length);
    // Choosing a real machine replaces the gone one rather than keeping it.
    await userEvent.click(screen.getByRole("menuitemradio", { name: "MacBook" }));
  });

  it("keeps reading as a check while the list is still empty", () => {
    setup(true, { machines: [], loading: true });
    expect(screen.getByRole("button", { name: /Checking/ }).hasAttribute("disabled")).toBe(true);
  });

  it("keeps the phone's action sheet rather than drawing a native select", async () => {
    setup(false);
    const chip = screen.getByRole("button", { name: /^Machine/ });
    await userEvent.click(chip);

    expect(chip.getAttribute("aria-expanded")).toBe("true");
    expect(document.querySelector("ion-action-sheet")).not.toBeNull();
    expect(document.querySelector("select")).toBeNull();
  });
});
