// @vitest-environment jsdom
import { fireEvent, render, screen } from "@testing-library/react";
import { describe, expect, it, vi } from "vitest";
import type { Approval } from "../../api/client";
import { t } from "../../i18n";
import FloatingApproval from "./FloatingApproval";

/**
 * The floating approval card. What is pinned here is the part that is a
 * decision rather than layout: which approval it shows (the one that has
 * waited longest, so a queue cannot starve), that answering it answers *that*
 * one, and that it says how many are behind it.
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
    raised: true,
    ...overrides,
  };
  const view = render(<FloatingApproval {...props} />);
  return { ...view, props, onDecide, onOpenTask };
}

describe("FloatingApproval", () => {
  it("renders nothing when nothing is waiting", () => {
    const { container } = setup({ approvals: [] });
    expect(container.innerHTML).toBe("");
  });

  it("shows the approval that has waited longest, not the newest", () => {
    setup();
    // The title button is the oldest approval's task, even though the newer one
    // is first in the list the resource publishes.
    expect(screen.getByRole("button", { name: "Fix the tests" })).toBeTruthy();
    expect(screen.queryByRole("button", { name: "Write the docs" })).toBeNull();
  });

  it("counts the approvals behind the one it shows", () => {
    setup();
    expect(screen.getByText("+1")).toBeTruthy();
  });

  it("answers the approval on screen", () => {
    const { onDecide } = setup();
    fireEvent.click(screen.getByRole("button", { name: new RegExp(t("chat.approve")) }));
    expect(onDecide).toHaveBeenCalledWith("oldest", "approved");
  });

  it("denies the approval on screen", () => {
    const { onDecide } = setup();
    fireEvent.click(screen.getByRole("button", { name: new RegExp(t("chat.deny")) }));
    expect(onDecide).toHaveBeenCalledWith("oldest", "denied");
  });

  it("opens the task the approval belongs to", () => {
    const { onOpenTask } = setup();
    fireEvent.click(screen.getByRole("button", { name: "Fix the tests" }));
    expect(onOpenTask).toHaveBeenCalledWith("task-1");
  });

  it("falls back to a generic name when the task is not loaded", () => {
    setup({ titleFor: () => "" });
    expect(screen.getByRole("button", { name: t("approval.floatingFallback") })).toBeTruthy();
  });

  it("shows one approval, so two cards never answer the same decision", () => {
    setup();
    expect(screen.getAllByRole("button", { name: new RegExp(t("chat.approve")) })).toHaveLength(1);
  });
});
