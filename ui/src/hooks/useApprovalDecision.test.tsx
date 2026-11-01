// @vitest-environment jsdom
import { act, renderHook, waitFor } from "@testing-library/react";
import { beforeEach, describe, expect, it, vi } from "vitest";
import type { Approval } from "../api/client";
import { useAppStore } from "../store/appStore";

/**
 * Answering an approval, shared by the inbox and the floating card. What is
 * pinned is the contract both surfaces depend on: the row goes busy while the
 * daemon is thinking, the answer lands in the shared resource so every list
 * drops it at once, and a failure says so and re-reads instead of pretending.
 */
const client = vi.hoisted(() => ({ decideApproval: vi.fn() }));
const resources = vi.hoisted(() => ({
  applyMessage: vi.fn(),
  refreshPending: vi.fn(),
}));

vi.mock("../api/client", async (importOriginal) => ({
  ...(await importOriginal<typeof import("../api/client")>()),
  ...client,
}));
vi.mock("../api/liveResources", () => ({ liveResources: resources }));

import { useApprovalDecision } from "./useApprovalDecision";

function approval(decision: Approval["decision"]): Approval {
  return {
    id: "a1",
    task_id: "task-1",
    kind: "tool",
    payload: {},
    decision,
    created_at: 1,
  };
}

describe("useApprovalDecision", () => {
  beforeEach(() => {
    client.decideApproval.mockReset();
    resources.applyMessage.mockReset();
    resources.refreshPending.mockReset();
  });

  it("marks the approval busy until the daemon answers", async () => {
    let answer: (value: Approval) => void = () => {};
    client.decideApproval.mockReturnValue(
      new Promise<Approval>((resolve) => {
        answer = resolve;
      }),
    );
    const { result } = renderHook(() => useApprovalDecision());

    let pending: Promise<Approval | null> = Promise.resolve(null);
    act(() => {
      pending = result.current.decide("a1", "approved");
    });
    await waitFor(() => expect(result.current.busy).toEqual({ a1: "approved" }));

    await act(async () => {
      answer(approval("approved"));
      await pending;
    });
    expect(result.current.busy).toEqual({});
  });

  it("applies the answer to the shared resource instead of refetching", async () => {
    const updated = approval("approved");
    client.decideApproval.mockResolvedValue(updated);
    const { result } = renderHook(() => useApprovalDecision());

    await act(async () => {
      await result.current.decide("a1", "approved");
    });

    expect(client.decideApproval).toHaveBeenCalledWith("a1", "approved");
    expect(resources.applyMessage).toHaveBeenCalledWith({
      kind: "approval_update",
      data: updated,
    });
    expect(resources.refreshPending).not.toHaveBeenCalled();
  });

  it("sends one answer per approval, however many times it is asked", async () => {
    // The inbox's keyboard model does not consult `busy`, so a held Enter key
    // can ask twice. The second request would be a 409 — the first decided it —
    // and its toast would report a failure for something that worked.
    let answer: (value: Approval) => void = () => {};
    client.decideApproval.mockReturnValue(
      new Promise<Approval>((resolve) => {
        answer = resolve;
      }),
    );
    const { result } = renderHook(() => useApprovalDecision());

    let first: Promise<Approval | null> = Promise.resolve(null);
    await act(async () => {
      first = result.current.decide("a1", "approved");
      await result.current.decide("a1", "approved");
    });

    expect(client.decideApproval).toHaveBeenCalledTimes(1);

    await act(async () => {
      answer(approval("approved"));
      await first;
    });
    expect(result.current.busy).toEqual({});
  });

  it("says what went wrong and re-reads the list when the call fails", async () => {
    const pushToast = vi.fn();
    useAppStore.setState({ pushToast });
    client.decideApproval.mockRejectedValue(new Error("daemon said no"));
    const { result } = renderHook(() => useApprovalDecision());

    await act(async () => {
      await result.current.decide("a1", "denied");
    });

    expect(pushToast).toHaveBeenCalledWith("daemon said no", "error");
    expect(resources.refreshPending).toHaveBeenCalled();
    expect(resources.applyMessage).not.toHaveBeenCalled();
    expect(result.current.busy).toEqual({});
  });
});
