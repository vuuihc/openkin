import { beforeEach, describe, expect, it, jest } from "@jest/globals";
import {
  act,
  fireEvent,
  render,
  waitFor,
} from "@testing-library/react-native";
import type {
  Approval,
  Task,
  TaskEvent,
  UserQuestion,
} from "../../../ui/src/api/contract";
import type { Session } from "../auth/tokenStore";
import { t } from "../i18n";
import ConversationScreen from "./ConversationScreen";

/**
 * The section is a function component and this RTL build exposes only host
 * nodes, so the test records the props the conversation handed it while the
 * real section still renders. Embedded mode draws no badge, and this is the
 * only place the mounted `pendingCount` is observable — it is the view state
 * the screen produced, not a second source.
 */
const mockSectionProps: Array<import("./Approvals").ApprovalsSectionProps> = [];
jest.mock("./Approvals", () => {
  const actual =
    jest.requireActual<typeof import("./Approvals")>("./Approvals");
  return {
    ...actual,
    ApprovalsSection: (props: import("./Approvals").ApprovalsSectionProps) => {
      mockSectionProps.push(props);
      return actual.ApprovalsSection(props);
    },
  };
});

/**
 * KIN-MOBILE-001 R5c — the conversation mounts the approval it is waiting on.
 *
 * R5's model and R5b's cards are proven in their own suites. This one is about
 * the mount: the conversation route reads the node's pending lists, shows only
 * the cards whose record belongs to this task above the transcript, sends the
 * same decision the web console sends, keeps a handled row and restores a
 * failed card, draws nothing when nothing is pending, and aborts the pending
 * read when the person leaves (AGENTS.md §11).
 *
 * The Keychain and the network are injected, so nothing here touches either.
 */

const TASK_ID = "task-1";
const ORIGIN = "https://kin.example.com";
const TOKEN = "fixture-token";

function task(overrides: Partial<Task> = {}): Task {
  return {
    id: TASK_ID,
    title: "A conversation",
    agent: "kin",
    cwd: "/work",
    prompt: "hello",
    model: "model-x",
    status: "succeeded",
    tokens_in: 0,
    tokens_out: 0,
    created_at: 1,
    event_epoch: 0,
    ...overrides,
  };
}

function event(
  seq: number,
  type = "message",
  payload: TaskEvent["payload"] = {},
): TaskEvent {
  return {
    task_id: TASK_ID,
    event_epoch: 0,
    seq,
    ts: 1_000 + seq,
    type,
    payload,
  };
}

const HISTORY: TaskEvent[] = [
  event(1, "message", {
    speaker: "user",
    role: "user",
    content: "run the tests",
    visibility: { user: true, task: true },
  }),
  event(2, "message", {
    speaker: "kin",
    content: "all green",
    visibility: { user: true, task: true },
  }),
  event(3, "result", { is_error: false }),
];

function approval(
  id: string,
  taskId: string,
  command: string,
  createdAt = 1,
): Approval {
  return {
    id,
    task_id: taskId,
    kind: "tool_use",
    payload: { tool_name: "Bash", input: { command } },
    decision: "pending",
    created_at: createdAt,
  };
}

function question(id: string, taskId: string, createdAt = 1): UserQuestion {
  return {
    id,
    task_id: taskId,
    payload: { question: "Proceed?", options: [{ label: "Yes" }] },
    status: "pending",
    created_at: createdAt,
  };
}

type Reply = { status?: number; body: unknown };
type Router = (url: string, init: RequestInit) => Reply | Promise<Reply>;
type Call = { url: string; init: RequestInit };

function ok(body: unknown, status = 200): Response {
  return {
    ok: status >= 200 && status < 300,
    status,
    json: async () => body,
  } as unknown as Response;
}

/** Records every request and answers through the test's own router. */
function routedFetch(route: Router): {
  fetchImpl: typeof fetch;
  calls: Call[];
} {
  const calls: Call[] = [];
  const impl = jest.fn(async (input: string, init?: RequestInit) => {
    calls.push({ url: input, init: init ?? {} });
    const reply = await route(input, init ?? {});
    return ok(reply.body, reply.status ?? 200);
  });
  return { fetchImpl: impl as unknown as typeof fetch, calls };
}

/** The task row and its event log: every case still reads a real transcript. */
function threadReply(url: string): Reply | undefined {
  if (url === `${ORIGIN}/api/tasks/${TASK_ID}/events`) return { body: HISTORY };
  if (url === `${ORIGIN}/api/tasks/${TASK_ID}`) return { body: task() };
  return undefined;
}

/** The two node-wide pending lists the conversation now reads beside the thread. */
function pendingReply(
  approvals: Approval[],
  questions: UserQuestion[] = [],
): (url: string) => Reply | undefined {
  return (url) => {
    if (url === `${ORIGIN}/api/approvals?status=pending`) {
      return { body: approvals };
    }
    if (url === `${ORIGIN}/api/user-questions?status=pending`) {
      return { body: questions };
    }
    return undefined;
  };
}

function storedSession(): Promise<Session | null> {
  return Promise.resolve({ kind: "node", origin: ORIGIN, token: TOKEN });
}

async function renderConversation(fetchImpl: typeof fetch) {
  return render(
    <ConversationScreen
      fetchImpl={fetchImpl}
      onBack={jest.fn()}
      readSessionImpl={storedSession}
      taskId={TASK_ID}
    />,
  );
}

/** Every string in the rendered tree, in draw order. */
function textsInOrder(node: unknown, out: string[] = []): string[] {
  if (typeof node === "string") {
    out.push(node);
    return out;
  }
  if (!node || typeof node !== "object") return out;
  const children = (node as { children?: unknown[] }).children;
  if (Array.isArray(children)) {
    for (const child of children) textsInOrder(child, out);
  }
  return out;
}

describe("KIN-MOBILE-001 R5 conversation approvals", () => {
  beforeEach(() => {
    mockSectionProps.length = 0;
  });

  it("KIN-MOBILE-001 R5: only this conversation's pending cards mount above the transcript", async () => {
    const mine = approval("a1", TASK_ID, "npm test --workspace api", 2);
    const other = approval("a-other", "task-other", "rm -rf /tmp/other", 1);
    const { fetchImpl } = routedFetch((url) => {
      const pending = pendingReply([mine, other])(url);
      if (pending) return pending;
      const thread = threadReply(url);
      if (thread) return thread;
      throw new Error(`unexpected request: ${url}`);
    });
    const screen = await renderConversation(fetchImpl);

    await waitFor(() =>
      expect(screen.getByTestId("card:approval:a1")).toBeTruthy(),
    );
    expect(screen.getByText("npm test --workspace api")).toBeTruthy();
    expect(screen.getByText(t("inbox.approvalsSection"))).toBeTruthy();
    // The other task's card is not this conversation's business.
    expect(screen.queryByTestId("card:approval:a-other")).toBeNull();
    expect(screen.queryByText("rm -rf /tmp/other")).toBeNull();

    // The card is drawn above the transcript it blocks.
    const order = textsInOrder(screen.toJSON());
    expect(order.indexOf(t("inbox.approvalsSection"))).toBeGreaterThanOrEqual(0);
    expect(order.indexOf(t("inbox.approvalsSection"))).toBeLessThan(
      order.indexOf("all green"),
    );
  });

  it("KIN-MOBILE-001 R5: approving from the conversation sends the decision and the card becomes handled", async () => {
    const first = approval("a1", TASK_ID, "npm test --workspace api", 2);
    const second = approval("a2", TASK_ID, "npm run lint", 1);
    const { fetchImpl, calls } = routedFetch((url) => {
      const pending = pendingReply([first, second])(url);
      if (pending) return pending;
      const thread = threadReply(url);
      if (thread) return thread;
      if (url === `${ORIGIN}/api/approvals/a1/decision`) {
        return { body: { ...first, decision: "approved" } };
      }
      throw new Error(`unexpected request: ${url}`);
    });
    const screen = await renderConversation(fetchImpl);

    await waitFor(() => expect(screen.getByTestId("approve:a1")).toBeTruthy());
    // The pending count is the section's own view state (embedded mode draws
    // no badge): read it from the mounted section, not a second source.
    const mounted = (): number =>
      mockSectionProps[mockSectionProps.length - 1].state.pendingCount;
    await waitFor(() => expect(mounted()).toBe(2));

    await fireEvent.press(screen.getByTestId("approve:a1"));

    await waitFor(() =>
      expect(screen.getByText(t("approval.decidedFallback"))).toBeTruthy(),
    );
    const post = calls.find(
      (call) => call.url === `${ORIGIN}/api/approvals/a1/decision`,
    );
    expect(post?.init.method).toBe("POST");
    expect(post?.init.body).toBe(JSON.stringify({ decision: "approved" }));
    // The handled card keeps its row and no longer counts as waiting.
    expect(screen.getByText(t("approval.approvedTitle"))).toBeTruthy();
    expect(screen.getByTestId("approve:a1").props.accessibilityState?.disabled).toBe(
      true,
    );
    expect(mounted()).toBe(1);
    // The other card is untouched and still actionable.
    expect(
      screen.getByTestId("approve:a2").props.accessibilityState?.disabled,
    ).toBe(false);
  });

  it("KIN-MOBILE-001 R5: a failed decision keeps the card operable and names the reason", async () => {
    const only = approval("a1", TASK_ID, "npm test --workspace api");
    const { fetchImpl } = routedFetch((url) => {
      const pending = pendingReply([only])(url);
      if (pending) return pending;
      const thread = threadReply(url);
      if (thread) return thread;
      if (url === `${ORIGIN}/api/approvals/a1/decision`) {
        return { status: 500, body: {} };
      }
      throw new Error(`unexpected request: ${url}`);
    });
    const screen = await renderConversation(fetchImpl);

    await waitFor(() => expect(screen.getByTestId("approve:a1")).toBeTruthy());
    await fireEvent.press(screen.getByTestId("approve:a1"));

    await waitFor(() =>
      expect(screen.getByText(t("inbox.decisionFailed"))).toBeTruthy(),
    );
    // One honest sentence from the shared catalogue, and the card still works.
    expect(screen.getByText(t("pairing.unreachable"))).toBeTruthy();
    expect(
      screen.getByTestId("approve:a1").props.accessibilityState?.disabled,
    ).toBe(false);
    expect(
      screen.getByTestId("deny:a1").props.accessibilityState?.disabled,
    ).toBe(false);
    expect(screen.queryByText(t("approval.decidedFallback"))).toBeNull();
    expect(screen.getByText(t("inbox.approvalsSection"))).toBeTruthy();
  });

  it("KIN-MOBILE-001 R5: a conversation with nothing pending mounts no approval card", async () => {
    const { fetchImpl, calls } = routedFetch((url) => {
      const pending = pendingReply([])(url);
      if (pending) return pending;
      const thread = threadReply(url);
      if (thread) return thread;
      throw new Error(`unexpected request: ${url}`);
    });
    const screen = await renderConversation(fetchImpl);

    await waitFor(() => expect(screen.getByText("all green")).toBeTruthy());
    // Both pending lists have answered: this is the settled empty state.
    await waitFor(() =>
      expect(
        calls.filter((call) => call.url.includes("status=pending")),
      ).toHaveLength(2),
    );
    await waitFor(() =>
      expect(screen.queryByText(t("inbox.loading"))).toBeNull(),
    );

    expect(screen.queryAllByTestId(/^card:/)).toHaveLength(0);
    expect(screen.queryByText(t("inbox.allClear"))).toBeNull();
    expect(screen.queryByText(t("inbox.allClearHint"))).toBeNull();
    expect(screen.queryByText(t("inbox.approvalsSection"))).toBeNull();
    expect(screen.getByText("all green")).toBeTruthy();
  });

  it("KIN-MOBILE-001 R5: leaving the conversation aborts the pending read and drops its answer", async () => {
    let approvalsSignal: AbortSignal | undefined;
    let resolveApprovals!: (reply: Reply) => void;
    const stalled = new Promise<Reply>((resolve) => {
      resolveApprovals = resolve;
    });
    const { fetchImpl } = routedFetch((url, init) => {
      if (url === `${ORIGIN}/api/approvals?status=pending`) {
        approvalsSignal = init.signal ?? undefined;
        return stalled;
      }
      if (url === `${ORIGIN}/api/user-questions?status=pending`) {
        return { body: [] };
      }
      const thread = threadReply(url);
      if (thread) return thread;
      throw new Error(`unexpected request: ${url}`);
    });
    const screen = await renderConversation(fetchImpl);

    await waitFor(() => expect(screen.getByText("all green")).toBeTruthy());
    await waitFor(() => expect(approvalsSignal).toBeDefined());
    expect(approvalsSignal?.aborted).toBe(false);

    await screen.unmount();

    // The model aborted the read it no longer owns (and its own dispose()).
    expect(approvalsSignal?.aborted).toBe(true);

    // The answer still arrives after the screen is gone; it mounts nothing.
    const painted = mockSectionProps.length;
    await act(async () => {
      resolveApprovals({
        body: [approval("a1", TASK_ID, "npm test --workspace api")],
      });
      await Promise.resolve();
    });
    expect(mockSectionProps.length).toBe(painted);
  });
});
