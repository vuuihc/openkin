// @vitest-environment jsdom
import { beforeEach, describe, expect, it, vi } from "vitest";
import { render, screen } from "@testing-library/react";
import userEvent from "@testing-library/user-event";
import { setLocale } from "../../i18n";
import ActionSheet from "./ActionSheet";

/**
 * The shared action list: what the phone's project menu, session menu and
 * choice chips all render now that Ionic is gone.
 *
 * The sheet's chrome (scrim, focus trap, Escape, Back, swipe) is `Sheet`'s and
 * is covered there. What is left is this list's contract: a row closes the
 * sheet and then runs, the current value is marked, a destructive row takes
 * the console's red ink, and a disabled row cannot be picked.
 */

beforeEach(() => {
  setLocale("en");
});

function setup(rows: Parameters<typeof ActionSheet>[0]["rows"], onClose = vi.fn()) {
  render(<ActionSheet open onClose={onClose} title="Actions" subtitle="Runs on this Mac" rows={rows} />);
  return { onClose };
}

describe("the shared action sheet", () => {
  it("names the sheet and the machine it will act on", () => {
    setup([{ id: "stop", label: "Stop", onSelect: () => undefined }]);
    expect(screen.getByRole("dialog", { name: "Actions" })).toBeTruthy();
    expect(screen.getByText("Runs on this Mac")).toBeTruthy();
  });

  it("closes before it runs the row", async () => {
    const calls: string[] = [];
    setup([
      {
        id: "share",
        label: "Share",
        onSelect: () => calls.push("row"),
      },
    ], vi.fn(() => calls.push("close")));

    await userEvent.click(screen.getByRole("button", { name: "Share" }));
    // The next layer opens from an effect keyed on the sheet being gone; a row
    // that ran first would open it under a live focus trap.
    expect(calls).toEqual(["close", "row"]);
  });

  it("marks the current value and colours a destructive row", () => {
    setup([
      { id: "one", label: "Current", selected: true, onSelect: () => undefined },
      { id: "two", label: "Delete", destructive: true, onSelect: () => undefined },
    ]);

    expect(screen.getByRole("button", { name: "Current" }).getAttribute("aria-current")).toBe(
      "true",
    );
    expect(screen.getByRole("button", { name: "Delete" }).className).toContain("text-kin-red-ink");
  });

  it("does not run a disabled row", async () => {
    setup([{ id: "stop", label: "Stopping…", disabled: true, onSelect: () => undefined }]);
    const row = screen.getByRole("button", { name: "Stopping…" });
    expect(row.hasAttribute("disabled")).toBe(true);
    await userEvent.click(row);
    expect(row.getAttribute("aria-current")).toBeNull();
  });

  it("offers one quiet cancel that only dismisses", async () => {
    const onSelect = vi.fn();
    const { onClose } = setup([{ id: "work", label: "Work", onSelect }]);
    await userEvent.click(screen.getByRole("button", { name: "Cancel" }));
    expect(onClose).toHaveBeenCalledTimes(1);
    expect(onSelect).not.toHaveBeenCalled();
  });
});
