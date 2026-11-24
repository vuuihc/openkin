import { describe, expect, it, jest } from "@jest/globals";
import { fireEvent, render } from "@testing-library/react-native";
import { StyleSheet } from "react-native";
import type { Approval, UserQuestion } from "@ui/api/contract";
import type {
  ApprovalEntry,
  ApprovalsState,
  QuestionEntry,
} from "../approvals/approvalsModel";
import Approvals, { type ApprovalsScreenProps } from "./Approvals";

/**
 * KIN-MOBILE-001 R5b — the approvals and questions screen.
 *
 * The view state is hand-built from the R5 model's own types so the test is
 * about presentation: which card shows under which heading, the waiting and
 * handled phases, the 44pt floor and reader labels, and the four non-ready
 * states. Reads, transitions and stale-answer rules are proven in
 * `approvalsModel.test.ts`.
 */

const t = (key: string): string => key;

function approval(id: string, createdAt = 1): Approval {
  return {
    id,
    task_id: "task-1",
    kind: "tool_use",
    payload: { tool_name: "Bash", input: { command: "ls -la" } },
    decision: "pending",
    created_at: createdAt,
  };
}

function question(id: string, createdAt = 2): UserQuestion {
  return {
    id,
    task_id: "task-1",
    payload: {
      question: "Proceed?",
      options: [{ label: "Yes" }, { label: "No" }],
    },
    status: "pending",
    created_at: createdAt,
  };
}

function approvalEntry(
  id: string,
  overrides: Partial<ApprovalEntry> = {},
): ApprovalEntry {
  const record = approval(id);
  return {
    key: `approval:${id}`,
    kind: "approval",
    id,
    createdAt: record.created_at,
    approval: record,
    phase: "idle",
    pending: true,
    ...overrides,
  };
}

function questionEntry(
  id: string,
  overrides: Partial<QuestionEntry> = {},
): QuestionEntry {
  const record = question(id);
  return {
    key: `question:${id}`,
    kind: "question",
    id,
    createdAt: record.created_at,
    question: record,
    phase: "idle",
    pending: true,
    ...overrides,
  };
}

function state(overrides: Partial<ApprovalsState> = {}): ApprovalsState {
  return {
    status: "ready",
    items: [],
    pendingCount: 0,
    online: true,
    revision: 1,
    ...overrides,
  };
}

function view(
  overrides: Partial<ApprovalsState> = {},
  props: Partial<ApprovalsScreenProps> = {},
) {
  return (
    <Approvals
      onAnswer={() => {}}
      onApprove={() => {}}
      onDeny={() => {}}
      state={state(overrides)}
      t={t}
      {...props}
    />
  );
}

/** What a `t` call saw, so a parameterized sentence can be asserted. */
type Translation = { key: string; params?: Record<string, string | number> };

function recordingT(seen: Translation[]) {
  return (key: string, params?: Record<string, string | number>): string => {
    seen.push({ key, params });
    return key;
  };
}

/** How many nodes in the rendered tree carry the given live region. */
function liveRegions(node: unknown, politeness = "polite"): number {
  if (!node || typeof node !== "object") return 0;
  const element = node as {
    props?: { accessibilityLiveRegion?: string };
    children?: unknown[];
  };
  const self =
    element.props?.accessibilityLiveRegion === politeness ? 1 : 0;
  const children = Array.isArray(element.children) ? element.children : [];
  return (
    self +
    children.reduce<number>((sum, child) => sum + liveRegions(child, politeness), 0)
  );
}

describe("KIN-MOBILE-001 R5 approvals and questions screen", () => {
  it("KIN-MOBILE-001 R5: approving a card enters a waiting state, then keeps a handled row and drops the badge by one", async () => {
    const onApprove = jest.fn();
    const seen: Translation[] = [];
    const translate = recordingT(seen);
    const first = approvalEntry("a1");
    const second = approvalEntry("a2", {
      approval: approval("a2", 2),
      createdAt: 2,
    });
    const screen = await render(
      view({ items: [first, second], pendingCount: 2 }, {
        onApprove,
        t: translate,
      }),
    );

    // Idle: the control is offered and the badge speaks the count.
    expect(
      screen.getByTestId("approve:a1").props.accessibilityState?.disabled,
    ).toBe(false);
    expect(seen).toContainEqual({
      key: "inbox.waiting",
      params: { count: 2 },
    });

    // Slow: the card says it is working and refuses a second submit.
    const submitting: ApprovalEntry = { ...first, phase: "submitting" };
    await screen.rerender(
      view({ items: [submitting, second], pendingCount: 2 }, {
        onApprove,
        t: translate,
      }),
    );
    const waiting = screen.getByTestId("approve:a1");
    expect(waiting.props.accessibilityState?.disabled).toBe(true);
    expect(screen.getByText("approval.approving")).toBeTruthy();
    await fireEvent.press(waiting);
    expect(onApprove).not.toHaveBeenCalled();

    // Settled: the one-line result stays and the count drops by one.
    const resolved: ApprovalEntry = {
      ...first,
      approval: { ...approval("a1"), decision: "approved" },
      phase: "resolved",
      pending: false,
      resolution: { kind: "approval", decision: "approved" },
    };
    seen.length = 0;
    await screen.rerender(
      view({ items: [resolved, second], pendingCount: 1 }, {
        onApprove,
        t: translate,
      }),
    );
    expect(screen.getByText("approval.approvedTitle")).toBeTruthy();
    expect(screen.getByText("approval.decidedFallback")).toBeTruthy();
    await fireEvent.press(screen.getByTestId("approve:a1"));
    expect(onApprove).not.toHaveBeenCalled();
    expect(seen).toContainEqual({
      key: "inbox.waiting",
      params: { count: 1 },
    });
  });

  it("KIN-MOBILE-001 R5: a failed decision restores the card as operable and names the reason", async () => {
    const onApprove = jest.fn();
    const onDeny = jest.fn();
    const onRetry = jest.fn();
    const failed = approvalEntry("a1", {
      failure: { reason: "unreachable", status: null },
    });
    const screen = await render(
      view({ items: [failed], pendingCount: 1 }, {
        onApprove,
        onDeny,
        onRetry,
      }),
    );

    expect(
      screen.getByTestId("approve:a1").props.accessibilityState?.disabled,
    ).toBe(false);
    expect(
      screen.getByTestId("deny:a1").props.accessibilityState?.disabled,
    ).toBe(false);
    expect(screen.getByText("pairing.unreachable")).toBeTruthy();

    await fireEvent.press(screen.getByTestId("retry:a1"));
    expect(onRetry).toHaveBeenCalledWith("a1");

    // No retry callback, no dead control.
    await screen.rerender(
      view({ items: [failed], pendingCount: 1 }, { onApprove, onDeny }),
    );
    expect(screen.queryByTestId("retry:a1")).toBeNull();
  });

  it("KIN-MOBILE-001 R5: offline disables submit and already-read approvals stay visible", async () => {
    const resolved = approvalEntry("a1", {
      approval: { ...approval("a1"), decision: "approved" },
      phase: "resolved",
      pending: false,
      resolution: { kind: "approval", decision: "approved" },
    });
    const pendingApproval = approvalEntry("a2", {
      approval: approval("a2", 2),
      createdAt: 2,
    });
    const pendingQuestion = questionEntry("q1");
    const screen = await render(
      view({
        items: [resolved, pendingApproval, pendingQuestion],
        pendingCount: 2,
        online: false,
      }),
    );

    expect(screen.getByText("approval.decidedFallback")).toBeTruthy();
    expect(screen.getByText("pairing.unreachable")).toBeTruthy();
    expect(
      screen.getByTestId("approve:a2").props.accessibilityState?.disabled,
    ).toBe(true);
    expect(
      screen.getByTestId("deny:a2").props.accessibilityState?.disabled,
    ).toBe(true);

    // A choice is local, but sending it is not allowed while offline.
    await fireEvent.press(screen.getByTestId("option:q1:0"));
    expect(
      screen.getByTestId("submit:q1").props.accessibilityState?.disabled,
    ).toBe(true);
  });

  it("KIN-MOBILE-001 R5: a pending list with nothing in it draws no card", async () => {
    const screen = await render(view({ status: "ready", items: [] }));
    expect(screen.queryAllByTestId(/^card:/)).toHaveLength(0);
    expect(screen.getByText("inbox.noneWaiting")).toBeTruthy();
    expect(screen.getByText("inbox.allClear")).toBeTruthy();
    expect(screen.getByText("inbox.allClearHint")).toBeTruthy();
  });

  it("KIN-MOBILE-001 R5: every action is a labelled control that speaks its action and object", async () => {
    const screen = await render(
      view({ items: [approvalEntry("a1")], pendingCount: 1 }),
    );
    const approve = screen.getByTestId("approve:a1");
    const deny = screen.getByTestId("deny:a1");

    expect(approve.props.accessibilityRole).toBe("button");
    expect(deny.props.accessibilityRole).toBe("button");
    expect(String(approve.props.accessibilityLabel)).toContain(
      "approval.approvedTitle",
    );
    expect(String(approve.props.accessibilityLabel)).toContain("Bash");
    expect(String(deny.props.accessibilityLabel)).toContain(
      "approval.deniedTitle",
    );
    expect(String(deny.props.accessibilityLabel)).toContain("Bash");

    for (const id of ["approve:a1", "deny:a1"]) {
      const style = StyleSheet.flatten(screen.getByTestId(id).props.style);
      expect(style.minHeight ?? 0).toBeGreaterThanOrEqual(44);
      expect(style.minWidth ?? 0).toBeGreaterThanOrEqual(44);
    }
  });

  it("KIN-MOBILE-001 R5: a question card answers with the chosen option and keeps the result row", async () => {
    const onAnswer = jest.fn();
    const pending = questionEntry("q1");
    const screen = await render(
      view({ items: [pending], pendingCount: 1 }, { onAnswer }),
    );

    const option = screen.getByTestId("option:q1:0");
    const optionStyle = StyleSheet.flatten(option.props.style);
    expect(optionStyle.minHeight ?? 0).toBeGreaterThanOrEqual(44);
    expect(optionStyle.minWidth ?? 0).toBeGreaterThanOrEqual(44);

    await fireEvent.press(option);
    await fireEvent.press(screen.getByTestId("submit:q1"));
    expect(onAnswer).toHaveBeenCalledTimes(1);
    expect(onAnswer).toHaveBeenCalledWith("q1", "Yes");

    const resolved: QuestionEntry = {
      ...pending,
      phase: "resolved",
      pending: false,
      resolution: { kind: "question", text: "Yes" },
    };
    await screen.rerender(view({ items: [resolved] }, { onAnswer }));
    expect(screen.getByText("Yes")).toBeTruthy();
    const submit = screen.queryByTestId("submit:q1");
    expect(
      submit === null || submit.props.accessibilityState?.disabled === true,
    ).toBe(true);
  });

  it("KIN-MOBILE-001 R5: a handled card announces its result once", async () => {
    const resolved = approvalEntry("a1", {
      approval: { ...approval("a1"), decision: "approved" },
      phase: "resolved",
      pending: false,
      resolution: { kind: "approval", decision: "approved" },
    });
    const stillWaiting = approvalEntry("a2", {
      approval: approval("a2", 2),
      createdAt: 2,
    });
    const screen = await render(
      view({ items: [resolved, stillWaiting], pendingCount: 1 }),
    );

    const result = screen.getByText("approval.decidedFallback");
    expect(result.props.accessibilityLiveRegion).toBe("polite");
    // Exactly one node announces: the settled row, not the card title.
    expect(liveRegions(screen.toJSON())).toBe(1);
    // The title is not the announcement: only the settled row is.
    expect(
      screen.getByText("approval.approvedTitle").props
        .accessibilityLiveRegion,
    ).toBeUndefined();
  });

  it("KIN-MOBILE-001 R5: loading and a failed read each say something", async () => {
    const onRefresh = jest.fn();
    const loading = await render(
      view({ status: "loading", items: [], pendingCount: 0 }),
    );
    expect(loading.getByText("inbox.loading")).toBeTruthy();

    const failed = await render(
      view(
        {
          status: "error",
          items: [],
          pendingCount: 0,
          error: { reason: "unreachable", status: null },
        },
        { onRefresh },
      ),
    );
    expect(failed.getByText("inbox.loadFailed")).toBeTruthy();
    expect(failed.getByText("pairing.retry")).toBeTruthy();
    await fireEvent.press(failed.getByTestId("refresh"));
    expect(onRefresh).toHaveBeenCalledTimes(1);
  });
});
