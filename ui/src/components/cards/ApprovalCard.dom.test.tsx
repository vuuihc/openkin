// @vitest-environment jsdom
import { useState } from "react";
import { beforeEach, describe, expect, it, vi } from "vitest";
import { act, render, screen, waitFor } from "@testing-library/react";
import userEvent from "@testing-library/user-event";
import { MemoryRouter, useLocation } from "react-router-dom";
import type { Approval } from "../../api/client";
import { decideApproval } from "../../api/client";
import { setLocale } from "../../i18n";
import { useApprovalDecision } from "../../hooks/useApprovalDecision";
import ApprovalCard from "./ApprovalCard";

/**
 * KIN-CONTINUE-001, step 6: answering an approval leaves the answer where the
 * question was.
 *
 * The card used to disappear the moment the pending list dropped it, so the
 * only trace of what was decided was that the conversation had moved on. Now
 * the same card stays put, says who decided and when, and stops offering the
 * buttons — and answering it never navigates away from the conversation.
 */

vi.mock("../../api/client", async (importOriginal) => {
  const actual = await importOriginal<typeof import("../../api/client")>();
  return { ...actual, decideApproval: vi.fn() };
});
vi.mock("../../api/liveResources", () => ({
  liveResources: { applyMessage: vi.fn(), refreshPending: vi.fn() },
}));
vi.mock("../../store/appStore", () => ({
  useAppStore: (select: (state: { pushToast: () => void }) => unknown) =>
    select({ pushToast: () => {} }),
}));

const pending: Approval = {
  id: "approval-1",
  task_id: "task-1",
  kind: "tool",
  payload: { tool: "Bash", input: { command: "rm -rf build" } },
  decision: "pending",
  created_at: 1_700_000_000_000,
};

/**
 * The same shape the conversation uses: keep the approval in state, ask the
 * shared hook, and adopt the answer it returns.
 */
function Harness() {
  const { busy, decide } = useApprovalDecision();
  const [approval, setApproval] = useState(pending);
  const answer = async (decision: "approved" | "denied") => {
    const updated = await decide(approval.id, decision);
    if (updated) setApproval(updated);
  };
  return (
    <ApprovalCard
      approval={approval}
      busy={busy[approval.id] ?? null}
      onApprove={() => void answer("approved")}
      onDeny={() => void answer("denied")}
    />
  );
}

function Where() {
  return <span data-testid="where">{useLocation().pathname}</span>;
}

function setup() {
  return render(
    <MemoryRouter initialEntries={["/tasks/task-1"]}>
      <Harness />
      <Where />
    </MemoryRouter>,
  );
}

const decided = (decision: "approved" | "denied"): Approval => ({
  ...pending,
  decision,
  decided_via: "web",
  decided_at: Date.now(),
});

beforeEach(() => {
  setLocale("en");
  vi.mocked(decideApproval).mockReset();
});

describe("the approval card", () => {
  it("turns into the answer in place, without leaving the conversation", async () => {
    vi.mocked(decideApproval).mockResolvedValue(decided("approved"));
    setup();

    await userEvent.click(screen.getByRole("button", { name: /Approve/ }));

    expect(await screen.findByText("Permission granted")).toBeTruthy();
    const status = screen.getByRole("status");
    expect(status.textContent).toContain("Decided online");
    // The button that had focus unmounted; the answer takes it, so the next
    // Tab continues from the card instead of from the top of the window.
    expect(document.activeElement).toBe(status);
    expect(screen.queryByRole("button", { name: /Approve/ })).toBeNull();
    expect(screen.queryByRole("button", { name: /Deny/ })).toBeNull();
    expect(screen.getByTestId("where").textContent).toBe("/tasks/task-1");
    expect(vi.mocked(decideApproval)).toHaveBeenCalledTimes(1);
    expect(vi.mocked(decideApproval)).toHaveBeenCalledWith("approval-1", "approved");
  });

  it("disables both answers while one is in flight, then shows the result", async () => {
    let resolve!: (approval: Approval) => void;
    vi.mocked(decideApproval).mockReturnValue(
      new Promise<Approval>((done) => {
        resolve = done;
      }),
    );
    setup();

    await userEvent.click(screen.getByRole("button", { name: /Deny/ }));

    const denying = screen.getByRole("button", { name: "Denying…" }) as HTMLButtonElement;
    expect(denying.disabled).toBe(true);
    expect((screen.getByRole("button", { name: /Approve/ }) as HTMLButtonElement).disabled).toBe(
      true,
    );

    await act(async () => {
      resolve(decided("denied"));
    });

    await waitFor(() => expect(screen.getByText("Permission denied")).toBeTruthy());
    expect(screen.queryByRole("button")).toBeNull();
  });

  it("does not take focus when another device answers", () => {
    const view = (approval: Approval) => (
      <MemoryRouter>
        <input aria-label="follow-up" />
        <ApprovalCard approval={approval} busy={null} onApprove={() => {}} onDeny={() => {}} />
      </MemoryRouter>
    );
    const { rerender } = render(view(pending));
    const input = screen.getByLabelText("follow-up") as HTMLInputElement;
    input.focus();

    // The phone answers the same approval while the reader is typing here.
    // The answer must appear in place, but the caret must not jump.
    rerender(view(decided("approved")));

    expect(screen.getByText("Permission granted")).toBeTruthy();
    expect(document.activeElement).toBe(input);
  });

  it("does not take focus after a failed answer the reader moved on from", async () => {
    // The request never reached the daemon, so nothing is on its way. The
    // reader gives up and goes back to writing; the phone then answers. That
    // decision must not pull the caret out of the field.
    vi.mocked(decideApproval).mockRejectedValue(new Error("offline"));
    function Probe({ approval }: { approval: Approval }) {
      const { busy, decide } = useApprovalDecision();
      return (
        <ApprovalCard
          approval={approval}
          busy={busy[approval.id] ?? null}
          onApprove={() => void decide(approval.id, "approved")}
          onDeny={() => {}}
        />
      );
    }
    const view = (approval: Approval) => (
      <MemoryRouter>
        <input aria-label="follow-up" />
        <Probe approval={approval} />
      </MemoryRouter>
    );
    const { rerender } = render(view(pending));

    await userEvent.click(screen.getByRole("button", { name: /Approve/ }));
    // While the answer is in flight the button reads "Approving…"; waiting for
    // the label to come back is waiting for the failure to be handled.
    await waitFor(() =>
      expect((screen.getByRole("button", { name: /Approve/ }) as HTMLButtonElement).disabled).toBe(
        false,
      ),
    );

    const input = screen.getByLabelText("follow-up") as HTMLInputElement;
    input.focus();
    rerender(view(decided("approved")));

    expect(screen.getByText("Permission granted")).toBeTruthy();
    expect(document.activeElement).toBe(input);
  });

  it("says only what the record supports when no channel was written", () => {
    render(
      <MemoryRouter>
        <ApprovalCard
          approval={{ ...pending, decision: "approved", decided_at: Date.now() }}
          busy={null}
          onApprove={() => {}}
          onDeny={() => {}}
        />
      </MemoryRouter>,
    );
    expect(screen.getByText("Permission granted")).toBeTruthy();
    // No "Decided via " with nothing after it, and no invented channel.
    expect(screen.getByRole("status").textContent?.startsWith("Decided")).toBe(true);
    expect(screen.getByRole("status").textContent).not.toContain("via");
  });

  it("calls an expired request expired, not denied", () => {
    render(
      <MemoryRouter>
        <ApprovalCard
          approval={{
            ...pending,
            decision: "expired",
            decided_via: "timeout",
            decided_at: Date.now(),
          }}
          busy={null}
          onApprove={() => {}}
          onDeny={() => {}}
        />
      </MemoryRouter>,
    );
    expect(screen.getByText("Permission request expired")).toBeTruthy();
    expect(screen.queryByText("Permission denied")).toBeNull();
    expect(screen.getByRole("status").textContent).toContain("Decided by timeout");
  });

  it("names a phone decision without printing the device id", () => {
    render(
      <MemoryRouter>
        <ApprovalCard
          approval={{
            ...pending,
            decision: "approved",
            decided_via: "ios:node-7f3a",
            decided_at: Date.now(),
          }}
          busy={null}
          onApprove={() => {}}
          onDeny={() => {}}
        />
      </MemoryRouter>,
    );
    const status = screen.getByRole("status").textContent ?? "";
    expect(status).toContain("Decided on a paired phone");
    expect(status).not.toContain("node-7f3a");
  });

  it("says the run stopped when the engine denied what was pending", () => {
    render(
      <MemoryRouter>
        <ApprovalCard
          approval={{
            ...pending,
            decision: "denied",
            decided_via: "interrupt",
            decided_at: Date.now(),
          }}
          busy={null}
          onApprove={() => {}}
          onDeny={() => {}}
        />
      </MemoryRouter>,
    );
    expect(screen.getByRole("status").textContent).toContain("Denied when the run stopped");
  });
});
