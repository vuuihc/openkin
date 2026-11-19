// @vitest-environment jsdom
import { fireEvent, render, screen } from "@testing-library/react";
import type { ReactNode } from "react";
import { describe, expect, it, vi } from "vitest";
import type { Approval } from "../../api/client";
import { t } from "../../i18n";
import PanelSurface from "../layout/PanelSurface";
import FloatingApproval from "./FloatingApproval";

/**
 * One topmost surface per screen.
 *
 * A panel is what the reader opened; the floating approval is what arrived. At
 * 390 a panel is full-bleed, so the decision card painted over it covered the
 * file body *and* the panel's own approval area — two answer surfaces for one
 * decision, and the one underneath unreadable. While a visible panel is open
 * the floating approval keeps the strip it already gives a phone tab root: the
 * approval stays noticeable and one tap from its task, but the card is not
 * mounted at all. Closing the panel brings the card back exactly as before.
 */
function approval(id: string, taskId: string, createdAt: number): Approval {
  return {
    id,
    task_id: taskId,
    kind: "tool",
    payload: { tool: "write_file", input: { path: "/tmp/a.txt" } },
    decision: "pending",
    created_at: createdAt,
  };
}

function setup(overrides: Partial<React.ComponentProps<typeof FloatingApproval>> = {}) {
  const onDecide = vi.fn();
  const onOpenTask = vi.fn();
  const props = {
    approvals: [approval("newer", "task-2", 200), approval("oldest", "task-1", 100)],
    titleFor: (taskId: string) => (taskId === "task-1" ? "Fix the tests" : "Write the docs"),
    busy: {},
    onDecide,
    onOpenTask,
    raised: false,
    screenKey: "/tasks/task-1",
    expectsBottomChrome: true,
    ...overrides,
  };
  return { props, onDecide, onOpenTask };
}

function panel(hidden = false): ReactNode {
  return (
    <PanelSurface label="Files" hidden={hidden}>
      file body
    </PanelSurface>
  );
}

const approveButton = () => screen.queryByRole("button", { name: new RegExp(t("chat.approve")) });
const denyButton = () => screen.queryByRole("button", { name: new RegExp(t("chat.deny")) });

describe("FloatingApproval with a panel open", () => {
  it("an open panel leaves only the strip, never the decision card", () => {
    const { props } = setup();
    render(
      <>
        {panel()}
        <FloatingApproval {...props} />
      </>,
    );

    // The strip: one live region, the task link, the queue behind it.
    const strip = document.querySelector("aside > [role='status']");
    expect(strip).not.toBeNull();
    expect(strip?.getAttribute("aria-live")).toBe("polite");
    expect(screen.getByRole("button", { name: /Fix the tests/ })).toBeTruthy();
    expect(screen.getByText("+1")).toBeTruthy();

    // …and no decision surface painted over the panel body.
    expect(approveButton()).toBeNull();
    expect(denyButton()).toBeNull();
  });

  it("closing the panel brings the decision card back", () => {
    const { props, onDecide } = setup();
    const view = render(
      <>
        {panel()}
        <FloatingApproval {...props} />
      </>,
    );
    expect(approveButton()).toBeNull();

    view.rerender(<FloatingApproval {...props} />);

    expect(approveButton()).toBeTruthy();
    expect(denyButton()).toBeTruthy();
    fireEvent.click(screen.getByRole("button", { name: new RegExp(t("chat.approve")) }));
    // The queue still answers the approval that has waited longest.
    expect(onDecide).toHaveBeenCalledWith("oldest", "approved");
  });

  it("two panels share one presence", () => {
    const { props } = setup();
    const view = render(
      <>
        <PanelSurface key="files" label="Files">
          file body
        </PanelSurface>
        <PanelSurface key="pr" label="Pull request">
          pr body
        </PanelSurface>
        <FloatingApproval {...props} />
      </>,
    );
    expect(approveButton()).toBeNull();

    // Closing one panel leaves the other on the screen, so the card stays away.
    view.rerender(
      <>
        <PanelSurface key="files" label="Files">
          file body
        </PanelSurface>
        <FloatingApproval {...props} />
      </>,
    );

    expect(approveButton()).toBeNull();
    expect(screen.getByRole("button", { name: /Fix the tests/ })).toBeTruthy();
  });

  it("a hidden panel does not suppress the card", () => {
    // The terminal stays mounted once opened and is hidden when it closes: a
    // surface that is not painted cannot be covered.
    const { props } = setup();
    render(
      <>
        {panel(true)}
        <FloatingApproval {...props} />
      </>,
    );

    expect(approveButton()).toBeTruthy();
    expect(denyButton()).toBeTruthy();
  });

  it("a phone tab root is unchanged", () => {
    // The `raised` path already kept the strip; with no panel open it must
    // still be the whole surface, not a card.
    const { props } = setup({
      raised: true,
      expectsBottomChrome: false,
      screenKey: "/sessions",
    });
    render(<FloatingApproval {...props} />);

    expect(approveButton()).toBeNull();
    expect(denyButton()).toBeNull();
    const control = screen.getByRole("button", { name: /Fix the tests/ });
    expect(control.textContent).toContain("+1");
  });
});
