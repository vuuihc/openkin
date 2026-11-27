import { beforeEach, describe, expect, it, jest } from "@jest/globals";
import {
  act,
  fireEvent,
  render,
  waitFor,
  within,
} from "@testing-library/react-native";
import { StyleSheet } from "react-native";
import { SafeAreaProvider } from "react-native-safe-area-context";
import type {
  Approval,
  Task,
  TaskEvent,
  UserQuestion,
} from "../../../ui/src/api/contract";
import type {
  ApprovalEntry,
  ApprovalsState,
} from "../approvals/approvalsModel";
import type { Session } from "../auth/tokenStore";
import { t } from "../i18n";
import { composerBottomInset } from "../native/insets";
import type { AppStateLike, AppStateStatus } from "../native/reconnect";
import type { ThreadState } from "../thread/threadModel";
import type { ApprovalsScreenProps } from "./Approvals";
import ConversationScreen from "./ConversationScreen";
import ConversationView from "./ConversationView";

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

/** The view state a thread read produced, with no turns: the dock needs none. */
function threadState(): ThreadState {
  return {
    taskId: TASK_ID,
    title: "A conversation",
    status: "ready",
    turns: [],
    running: false,
    sendQueue: [],
    banner: null,
    reason: null,
  };
}

/** One pending card, already scoped to this task by the container. */
function approvalsProps(): ApprovalsScreenProps {
  const record = approval("a1", TASK_ID, "npm test --workspace api");
  const entry: ApprovalEntry = {
    key: "approval:a1",
    kind: "approval",
    id: record.id,
    createdAt: record.created_at,
    approval: record,
    phase: "idle",
    pending: true,
  };
  const state: ApprovalsState = {
    status: "ready",
    items: [entry],
    pendingCount: 1,
    online: true,
    revision: 1,
  };
  return {
    state,
    t,
    onApprove: jest.fn(),
    onDeny: jest.fn(),
    onAnswer: jest.fn(),
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

async function renderConversation(
  fetchImpl: typeof fetch,
  props: Partial<Parameters<typeof ConversationScreen>[0]> = {},
) {
  return render(
    <ConversationScreen
      fetchImpl={fetchImpl}
      onBack={jest.fn()}
      readSessionImpl={storedSession}
      taskId={TASK_ID}
      {...props}
    />,
  );
}

/**
 * The slice of `AppState` the conversation subscribes to. `currentState` is
 * what the screen reads before its first transition, so the fake tracks it:
 * the real module reports the platform's current status there.
 */
function fakeAppState(): {
  port: AppStateLike;
  emit: (status: AppStateStatus) => void;
} {
  let current: AppStateStatus = "active";
  const listeners = new Set<(status: AppStateStatus) => void>();
  return {
    port: {
      get currentState() {
        return current;
      },
      addEventListener(_type, listener) {
        listeners.add(listener);
        return {
          remove() {
            listeners.delete(listener);
          },
        };
      },
    },
    emit(status) {
      current = status;
      for (const listener of [...listeners]) listener(status);
    },
  };
}

/** The background → active edge every leave-and-return test fires. */
async function leaveAndReturn(app: {
  emit: (status: AppStateStatus) => void;
}): Promise<void> {
  await act(async () => {
    app.emit("background");
  });
  await act(async () => {
    app.emit("active");
  });
}

describe("KIN-MOBILE-001 R5 conversation approvals", () => {
  beforeEach(() => {
    mockSectionProps.length = 0;
  });

  it("KIN-MOBILE-002 R5d: the pending card docks above the composer, not in the transcript", async () => {
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
    // The other task's card is not this conversation's business.
    expect(screen.queryByTestId("card:approval:a-other")).toBeNull();
    expect(screen.queryByText("rm -rf /tmp/other")).toBeNull();

    // What blocks the next turn is a sibling of the scroller, docked above the
    // composer, so it stays in reach at every scroll position (TASTE §18).
    const dock = screen.getByTestId("conversation:approvalDock");
    expect(within(dock).getByTestId("card:approval:a1")).toBeTruthy();
    // It is not a row of the transcript: scrolling two screens down must not
    // carry the card the turn is waiting on out of view.
    expect(
      within(screen.getByTestId("conversation:turns")).queryByTestId(
        "card:approval:a1",
      ),
    ).toBeNull();
    // The dock sits before the composer in draw order, so the composer stays
    // reachable below it.
    expect(
      screen
        .getAllByTestId(/^conversation:(approvalDock|composerDock)$/)
        .map((node) => node.props.testID),
    ).toEqual(["conversation:approvalDock", "conversation:composerDock"]);
  });

  it("KIN-MOBILE-002 R5d: a conversation without a composer still docks the card", async () => {
    // `ConversationScreen` passes `onSend` only once a thread loaded, so a
    // failed read leaves no composer. The card that blocks the turn must not
    // leave with it: the dock is outside that conditional.
    const screen = await render(
      <SafeAreaProvider
        initialMetrics={{
          frame: { x: 0, y: 0, width: 390, height: 844 },
          insets: { top: 59, left: 0, right: 0, bottom: 34 },
        }}
      >
        <ConversationView
          approvals={approvalsProps()}
          onBack={jest.fn()}
          state={threadState()}
          t={t}
        />
      </SafeAreaProvider>,
    );

    expect(screen.getByTestId("conversation:approvalDock")).toBeTruthy();
    expect(
      within(screen.getByTestId("conversation:approvalDock")).getByTestId(
        "card:approval:a1",
      ),
    ).toBeTruthy();
    expect(screen.queryByTestId("conversation:composerDock")).toBeNull();
    // The dock is the last child here, so the composer's home-indicator
    // clearance moves onto it: the Approve/Deny row must not sit in the
    // gesture band (the composer suite pins the same number).
    const dock = StyleSheet.flatten(
      screen.getByTestId("conversation:approvalDock").props.style,
    );
    expect(dock.paddingBottom).toBe(composerBottomInset(34));
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

  it("KIN-MOBILE-001 R5: a decision settled on another device is gone after the app returns to the foreground", async () => {
    const only = approval("a1", TASK_ID, "npm test --workspace api");
    let approvalReads = 0;
    const { fetchImpl } = routedFetch((url) => {
      if (url === `${ORIGIN}/api/approvals?status=pending`) {
        approvalReads += 1;
        // The Mac handled the same approval while the phone was away; the
        // server no longer offers it, so a fresh read must not draw it.
        return { body: approvalReads === 1 ? [only] : [] };
      }
      if (url === `${ORIGIN}/api/user-questions?status=pending`) {
        return { body: [] };
      }
      const thread = threadReply(url);
      if (thread) return thread;
      throw new Error(`unexpected request: ${url}`);
    });
    const app = fakeAppState();
    const screen = await renderConversation(fetchImpl, { appState: app.port });

    await waitFor(() => expect(screen.getByTestId("approve:a1")).toBeTruthy());
    expect(approvalReads).toBe(1);

    await leaveAndReturn(app);

    // One read on the return edge; the settled card is absent from its answer
    // and so leaves the screen instead of staying pressed-but-rejected.
    await waitFor(() =>
      expect(screen.queryByTestId("card:approval:a1")).toBeNull(),
    );
    expect(approvalReads).toBe(2);
    expect(screen.queryByTestId("approve:a1")).toBeNull();
    expect(screen.queryByTestId("deny:a1")).toBeNull();
  });

  it("KIN-MOBILE-001 R8: the foreground re-read keeps a card that is still pending", async () => {
    const only = approval("a1", TASK_ID, "npm test --workspace api");
    let approvalReads = 0;
    let release!: () => void;
    const held = new Promise<void>((resolve) => {
      release = resolve;
    });
    const { fetchImpl } = routedFetch(async (url) => {
      if (url === `${ORIGIN}/api/approvals?status=pending`) {
        approvalReads += 1;
        // Hold the return read so the screen is inspected while it is still
        // on the wire, not after it landed.
        if (approvalReads === 2) await held;
        return { body: [only] };
      }
      if (url === `${ORIGIN}/api/user-questions?status=pending`) {
        return { body: [] };
      }
      const thread = threadReply(url);
      if (thread) return thread;
      throw new Error(`unexpected request: ${url}`);
    });
    const app = fakeAppState();
    const screen = await renderConversation(fetchImpl, { appState: app.port });

    await waitFor(() => expect(screen.getByTestId("approve:a1")).toBeTruthy());
    await leaveAndReturn(app);
    await waitFor(() => expect(approvalReads).toBe(2));

    // Still pending on the server: the card keeps its place and its idle
    // phase while the read is in flight, and the transcript already read is
    // not replaced by the first-load skeleton (TASTE 15).
    expect(
      screen.getByTestId("approve:a1").props.accessibilityState?.disabled,
    ).toBe(false);
    expect(
      mockSectionProps[mockSectionProps.length - 1].state.items[0]?.phase,
    ).toBe("idle");
    expect(screen.getByText("all green")).toBeTruthy();
    expect(screen.queryByTestId("conversation-skeleton")).toBeNull();

    await act(async () => {
      release();
      await held;
    });

    await waitFor(() =>
      expect(screen.queryByText(t("inbox.loading"))).toBeNull(),
    );
    expect(screen.getByTestId("approve:a1")).toBeTruthy();
    expect(screen.getByText("all green")).toBeTruthy();
    expect(screen.queryByTestId("conversation-skeleton")).toBeNull();
  });

  it("KIN-MOBILE-001 R8: a failed foreground re-read keeps the cards already on screen", async () => {
    const only = approval("a1", TASK_ID, "npm test --workspace api");
    let approvalReads = 0;
    const { fetchImpl } = routedFetch((url) => {
      if (url === `${ORIGIN}/api/approvals?status=pending`) {
        approvalReads += 1;
        // The node cannot answer the return read: a disconnect must not erase
        // what the person has already seen (the model's stale-but-usable rule).
        return approvalReads === 1 ? { body: [only] } : { status: 503, body: {} };
      }
      if (url === `${ORIGIN}/api/user-questions?status=pending`) {
        return { body: [] };
      }
      const thread = threadReply(url);
      if (thread) return thread;
      throw new Error(`unexpected request: ${url}`);
    });
    const app = fakeAppState();
    const screen = await renderConversation(fetchImpl, { appState: app.port });

    await waitFor(() => expect(screen.getByTestId("approve:a1")).toBeTruthy());
    await leaveAndReturn(app);
    await waitFor(() => expect(approvalReads).toBe(2));
    await waitFor(() =>
      expect(screen.queryByText(t("inbox.loading"))).toBeNull(),
    );

    // The card survives the failed read, still idle and operable, and nothing
    // claims a decision was made.
    expect(
      screen.getByTestId("approve:a1").props.accessibilityState?.disabled,
    ).toBe(false);
    expect(
      screen.getByTestId("deny:a1").props.accessibilityState?.disabled,
    ).toBe(false);
    expect(
      mockSectionProps[mockSectionProps.length - 1].state.items[0]?.phase,
    ).toBe("idle");
    expect(screen.queryByText(t("approval.decidedFallback"))).toBeNull();
    expect(screen.queryByText(t("approval.approvedTitle"))).toBeNull();
  });
});
