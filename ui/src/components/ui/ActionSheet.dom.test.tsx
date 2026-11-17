// @vitest-environment jsdom
import { useState } from "react";
import { beforeEach, describe, expect, it, vi } from "vitest";
import { render, screen, waitFor, within } from "@testing-library/react";
import userEvent from "@testing-library/user-event";
import { setLocale } from "../../i18n";
import ActionSheet from "./ActionSheet";

/**
 * KIN-CONTINUE-001: the shared action list behind the phone's project menu,
 * session menu and choice chips.
 *
 * The sheet's chrome (scrim, focus trap, Escape, Back, swipe) is `Sheet`'s and
 * is covered there. What is left is this list's contract: a row closes the
 * sheet and then runs, the current value is marked, a destructive row takes
 * the console's red ink, and a disabled row cannot be picked.
 */

beforeEach(() => {
  setLocale("en");
  window.history.replaceState({ idx: 0 }, "", "/sessions");
});

function Host({
  rows,
  onClose,
}: {
  rows: Parameters<typeof ActionSheet>[0]["rows"];
  onClose: () => void;
}) {
  const [open, setOpen] = useState(true);
  return (
    <ActionSheet
      open={open}
      onClose={() => {
        onClose();
        setOpen(false);
      }}
      title="Actions"
      subtitle="Runs on this Mac"
      rows={rows}
    />
  );
}

function setup(rows: Parameters<typeof ActionSheet>[0]["rows"], onClose = vi.fn()) {
  render(<Host rows={rows} onClose={onClose} />);
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
    setup(
      [
        {
          id: "share",
          label: "Share",
          onSelect: () => calls.push("row"),
        },
      ],
      vi.fn(() => calls.push("close")),
    );

    await userEvent.click(screen.getByRole("button", { name: "Share" }));
    // The row runs only once the sheet's history entry is behind us; a row that
    // navigated first would strand that entry under the next screen.
    await waitFor(() => expect(calls).toEqual(["close", "row"]));
  });

  it("gives its history entry back before a row navigates", async () => {
    const calls: string[] = [];
    setup(
      [
        {
          id: "open",
          label: "Open",
          onSelect: () => {
            calls.push("row");
            window.history.pushState({ idx: 1 }, "", "/tasks/run-1");
          },
        },
      ],
      vi.fn(() => calls.push("close")),
    );

    await userEvent.click(screen.getByRole("button", { name: "Open" }));
    await waitFor(() => expect(window.location.pathname).toBe("/tasks/run-1"));
    expect((window.history.state as { kinSheet?: string }).kinSheet).toBeUndefined();

    // The list is directly below the conversation, not the sheet's same-URL
    // marker: one Back reaches it, a second leaves it.
    window.history.back();
    await waitFor(() => expect(window.location.pathname).toBe("/sessions"));
    expect((window.history.state as { kinSheet?: string }).kinSheet).toBeUndefined();
    expect((window.history.state as { idx?: number }).idx).toBe(0);
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
    const onSelect = vi.fn();
    const { onClose } = setup([{ id: "stop", label: "Stopping…", disabled: true, onSelect }]);
    const row = screen.getByRole("button", { name: "Stopping…" });
    expect(row.hasAttribute("disabled")).toBe(true);
    await userEvent.click(row);
    expect(onSelect).not.toHaveBeenCalled();
    expect(onClose).not.toHaveBeenCalled();
  });

  it("draws a row's hint as a second line and keeps both lines in its name", () => {
    const hint = "Leaves this catalog only; it is not uninstalled.";
    setup([{ id: "remove", label: "Remove from catalog", hint, onSelect: () => undefined }]);

    // The hint is part of the button, so it is both visible and part of the
    // name a screen reader hears — not a `title` a phone cannot reach.
    const row = screen.getByRole("button", { name: /Remove from catalog.*not uninstalled/ });
    expect(within(row).getByText(hint)).toBeTruthy();
    expect(row.textContent).toContain("Remove from catalog");
  });

  it("leaves a disabled row's reason on the surface and the row unpickable", async () => {
    const onSelect = vi.fn();
    const reason = "The default agent stays in the catalog. Set another agent as default first.";
    const { onClose } = setup([
      { id: "remove", label: "Remove from catalog", hint: reason, disabled: true, onSelect },
    ]);

    const row = screen.getByRole("button", { name: /^Remove from catalog/ });
    expect(row.hasAttribute("disabled")).toBe(true);
    // A disabled row cannot be focused, so its reason has to be on the surface.
    expect(within(row).getByText(reason)).toBeTruthy();
    await userEvent.click(row);
    expect(onSelect).not.toHaveBeenCalled();
    expect(onClose).not.toHaveBeenCalled();
  });

  it("draws one line for a row without a hint", () => {
    setup([{ id: "share", label: "Share", onSelect: () => undefined }]);

    const row = screen.getByRole("button", { name: "Share" });
    expect(row.querySelector(".text-caption")).toBeNull();
  });

  it("offers one quiet cancel that only dismisses", async () => {
    const onSelect = vi.fn();
    const { onClose } = setup([{ id: "work", label: "Work", onSelect }]);
    await userEvent.click(screen.getByRole("button", { name: "Cancel" }));
    expect(onClose).toHaveBeenCalledTimes(1);
    expect(onSelect).not.toHaveBeenCalled();
  });
});
