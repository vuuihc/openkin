// @vitest-environment jsdom
import { render, screen } from "@testing-library/react";
import { afterEach, describe, expect, it, vi } from "vitest";
import type { Approval } from "../../api/client";

/**
 * What a bad payload costs.
 *
 * `ApprovalCard` renders what the agent asked for, and that value is not ours.
 * The floating card therefore wraps it in an error boundary — this file is the
 * proof that the boundary is load-bearing and, just as important, that it lets
 * go: a boundary stuck in its caught state would hide every *later* approval
 * on every screen until a reload, which is the failure the card exists to
 * prevent.
 */
vi.mock("./ApprovalCard", () => ({
  default: ({ approval }: { approval: Approval }) => {
    if (approval.id === "bad") throw new Error("payload");
    return <div>card {approval.id}</div>;
  },
}));

import FloatingApproval from "./FloatingApproval";

function approval(id: string, createdAt: number): Approval {
  return {
    id,
    task_id: "task-1",
    kind: "tool",
    payload: {},
    decision: "pending",
    created_at: createdAt,
  };
}

const base = {
  titleFor: () => "Fix the tests",
  busy: {},
  onDecide: () => {},
  onOpenTask: () => {},
  raised: true,
  screenKey: "/sessions",
  expectsBottomChrome: false,
};

describe("FloatingApproval containment", () => {
  afterEach(() => vi.restoreAllMocks());

  it("keeps the strip when the card cannot render", () => {
    vi.spyOn(console, "error").mockImplementation(() => {});
    render(<FloatingApproval {...base} approvals={[approval("bad", 100)]} />);
    // The label and the task link still render; the card itself is gone.
    expect(screen.getByRole("button", { name: "Fix the tests" })).toBeTruthy();
    expect(screen.queryByText(/card bad/)).toBeNull();
  });

  it("renders the next approval after a bad one", () => {
    vi.spyOn(console, "error").mockImplementation(() => {});
    const { rerender } = render(
      <FloatingApproval {...base} approvals={[approval("bad", 100)]} />,
    );
    // The bad one is answered elsewhere or expires; the queue moves on.
    rerender(<FloatingApproval {...base} approvals={[approval("good", 200)]} />);
    expect(screen.getByText("card good")).toBeTruthy();
  });
});
