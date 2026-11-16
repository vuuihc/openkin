// @vitest-environment jsdom
import { render, screen } from "@testing-library/react";
import userEvent from "@testing-library/user-event";
import { describe, expect, it, vi } from "vitest";
import Toast, { type ToastItem } from "./Toast";

/**
 * F5e2: the shared toast strip the ToastHost migration will consume.
 *
 * The contract is what a toast *is*, not how it is painted: every toast is its
 * own polite status region, the caller owns the list and the removal (a
 * dismiss reports one id and changes nothing here), an empty list renders no
 * live region at all, and the dismiss control keeps a 44px touch floor with a
 * name the caller supplies in the reader's language.
 */

const DISMISS = "关闭通知";

function renderToasts(toasts: ToastItem[], onDismiss = vi.fn()) {
  return render(<Toast toasts={toasts} onDismiss={onDismiss} dismissLabel={DISMISS} />);
}

describe("the shared toast strip", () => {
  it("renders role=status with aria-live=polite for every tone", () => {
    const messages = ["Draft saved", "Run finished", "Upload failed"];
    renderToasts([
      { id: "info", message: messages[0], tone: "info" },
      { id: "success", message: messages[1], tone: "success" },
      { id: "error", message: messages[2], tone: "error" },
    ]);

    const statuses = screen.getAllByRole("status");
    expect(statuses).toHaveLength(3);
    statuses.forEach((status, index) => {
      expect(status.getAttribute("aria-live")).toBe("polite");
      // The tone changes the ink, never the message: one row per item, in the
      // order the caller holds them.
      expect(status.textContent).toContain(messages[index]);
    });

    // One announcement owner: the items are live regions, the strip is not a
    // second one (nested live regions make some readers speak twice).
    const strip = statuses[0].parentElement;
    expect(strip?.hasAttribute("aria-live")).toBe(false);
    expect(strip?.getAttribute("role")).toBeNull();
  });

  it("dismiss calls onDismiss with that toast id", async () => {
    const onDismiss = vi.fn();
    renderToasts(
      [
        { id: "first", message: "First result", tone: "info" },
        { id: "second", message: "Second result", tone: "error" },
      ],
      onDismiss,
    );

    const dismissButtons = screen.getAllByRole("button", { name: DISMISS });
    expect(dismissButtons).toHaveLength(2);

    await userEvent.click(dismissButtons[0]);

    expect(onDismiss).toHaveBeenCalledTimes(1);
    expect(onDismiss).toHaveBeenCalledWith("first");
  });

  it("renders nothing for an empty list", () => {
    const { container } = renderToasts([]);

    expect(container.innerHTML).toBe("");
    expect(screen.queryByRole("status")).toBeNull();
  });

  it("the dismiss control is at least 44px and has an accessible name", () => {
    renderToasts([{ id: "only", message: "Saved", tone: "success" }]);

    const dismiss = screen.getByRole("button", { name: DISMISS });

    // jsdom has no layout, so this asserts the class that owns the floor: a
    // 44px square on touch, released on a wide screen where the pointer is fine.
    expect(dismiss.className).toContain("min-h-11");
    expect(dismiss.className).toContain("min-w-11");
    expect(dismiss.className).toContain("sm:min-h-0");
    expect(dismiss.className).toContain("focus-visible:outline-kin-focus-ring");
    expect(dismiss.getAttribute("type")).toBe("button");
    // The name is the caller's prop, not a hard-coded English fallback.
    expect(dismiss.getAttribute("aria-label")).toBe(DISMISS);
  });

  it("carries the tone in the ink over one opaque surface", () => {
    renderToasts([
      { id: "info", message: "Draft saved", tone: "info" },
      { id: "success", message: "Run finished", tone: "success" },
      { id: "error", message: "Upload failed", tone: "error" },
      { id: "default", message: "Tone omitted" },
    ]);

    const [info, success, error, defaulted] = screen.getAllByRole("status");
    for (const status of [info, success, error, defaulted]) {
      // Solid surface only: a toast floats over scrolling content, so a tint
      // has no fixed backdrop to be measured against.
      expect(status.className).toContain("bg-kin-elevated");
    }
    expect(info.className).toContain("text-kin-text");
    expect(success.className).toContain("text-kin-green-ink");
    expect(error.className).toContain("text-kin-red-ink");
    // An omitted tone is `info`, not the last tone the map happened to hold.
    expect(defaulted.className).toContain("text-kin-text");
    expect(defaulted.className).not.toContain("text-kin-green-ink");
    expect(defaulted.className).not.toContain("text-kin-red-ink");
  });
});
