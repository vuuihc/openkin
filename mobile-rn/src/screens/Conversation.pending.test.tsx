import { describe, expect, it, jest } from "@jest/globals";
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
 * KIN-MOBILE-001 R5 — a settled pending decision tells the split's list to
 * re-read.
 *
 * The conversation's cards settle inside `approvalsModel` (R5, proven in
 * `Conversation.approvals.test.tsx`). What this suite adds is the one outward
 * signal: only a decision the model actually settled may tell the sibling list
 * its badges are stale. A failed decision changed nothing on the server, and a
 * decision the model dropped as stale belongs to a conversation that is gone
 * (AGENTS.md §11), so neither may bump the list.
 *
 * The Keychain and the network are injected, so nothing here touches either.
 */

const TASK_ID = "task-1";
const ORIGIN = "https://kin.example.com";
const TOKEN = "token-for-tests";

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

function approval(id: string, command: string): Approval {
  return {
    id,
    task_id: TASK_ID,
    kind: "tool_use",
    payload: { tool_name: "Bash", input: { command } },
    decision: "pending",
    created_at: 1,
  };
}

function question(id: string): UserQuestion {
  return {
    id,
    task_id: TASK_ID,
    payload: { question: "Proceed?", options: [{ label: "Yes" }] },
    status: "pending",
    created_at: 2,
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

function threadReply(url: string): Reply | undefined {
  if (url === `${ORIGIN}/api/tasks/${TASK_ID}/events`) return { body: HISTORY };
  if (url === `${ORIGIN}/api/tasks/${TASK_ID}`) return { body: task() };
  return undefined;
}

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
  onPendingSettled: () => void,
) {
  return render(
    <ConversationScreen
      fetchImpl={fetchImpl}
      onBack={jest.fn()}
      onPendingSettled={onPendingSettled}
      readSessionImpl={storedSession}
      taskId={TASK_ID}
    />,
  );
}

describe("KIN-MOBILE-001 R5 pending decisions settle the list", () => {
  it("KIN-MOBILE-001 R5: a settled approval tells the route to refresh the list's badges", async () => {
    const only = approval("a1", "npm test --workspace api");
    const { fetchImpl, calls } = routedFetch((url) => {
      const pending = pendingReply([only])(url);
      if (pending) return pending;
      const thread = threadReply(url);
      if (thread) return thread;
      if (url === `${ORIGIN}/api/approvals/a1/decision`) {
        return { body: { ...only, decision: "approved" } };
      }
      throw new Error(`unexpected request: ${url}`);
    });
    const onPendingSettled = jest.fn();
    const screen = await renderConversation(fetchImpl, onPendingSettled);

    await waitFor(() => expect(screen.getByTestId("approve:a1")).toBeTruthy());
    await fireEvent.press(screen.getByTestId("approve:a1"));

    await waitFor(() =>
      expect(screen.getByText(t("approval.decidedFallback"))).toBeTruthy(),
    );
    expect(
      calls.filter((call) => call.url === `${ORIGIN}/api/approvals/a1/decision`),
    ).toHaveLength(1);
    await waitFor(() => expect(onPendingSettled).toHaveBeenCalledTimes(1));
  });

  it("KIN-MOBILE-001 R5: a denied approval and a submitted answer also settle the list", async () => {
    const denied = approval("a1", "rm -rf /tmp/work");
    const asked = question("q1");
    const { fetchImpl } = routedFetch((url) => {
      const pending = pendingReply([denied], [asked])(url);
      if (pending) return pending;
      const thread = threadReply(url);
      if (thread) return thread;
      if (url === `${ORIGIN}/api/approvals/a1/decision`) {
        return { body: { ...denied, decision: "denied" } };
      }
      if (url === `${ORIGIN}/api/user-questions/q1/answer`) {
        return { body: { ...asked, status: "answered" } };
      }
      throw new Error(`unexpected request: ${url}`);
    });
    const onPendingSettled = jest.fn();
    const screen = await renderConversation(fetchImpl, onPendingSettled);

    await waitFor(() => expect(screen.getByTestId("deny:a1")).toBeTruthy());
    await fireEvent.press(screen.getByTestId("deny:a1"));
    await waitFor(() => expect(onPendingSettled).toHaveBeenCalledTimes(1));

    await waitFor(() => expect(screen.getByTestId("option:q1:0")).toBeTruthy());
    await fireEvent.press(screen.getByTestId("option:q1:0"));
    await fireEvent.press(screen.getByTestId("submit:q1"));
    await waitFor(() => expect(onPendingSettled).toHaveBeenCalledTimes(2));
  });

  it("KIN-MOBILE-001 R5: a failed decision settles nothing", async () => {
    const only = approval("a1", "npm test --workspace api");
    const { fetchImpl, calls } = routedFetch((url) => {
      const pending = pendingReply([only])(url);
      if (pending) return pending;
      const thread = threadReply(url);
      if (thread) return thread;
      if (url === `${ORIGIN}/api/approvals/a1/decision`) {
        return { status: 500, body: {} };
      }
      throw new Error(`unexpected request: ${url}`);
    });
    const onPendingSettled = jest.fn();
    const screen = await renderConversation(fetchImpl, onPendingSettled);

    await waitFor(() => expect(screen.getByTestId("approve:a1")).toBeTruthy());
    await fireEvent.press(screen.getByTestId("approve:a1"));

    // The decision really failed and the card recovered before counting.
    await waitFor(() =>
      expect(screen.getByText(t("inbox.decisionFailed"))).toBeTruthy(),
    );
    expect(
      calls.filter((call) => call.url === `${ORIGIN}/api/approvals/a1/decision`),
    ).toHaveLength(1);
    expect(
      screen.getByTestId("approve:a1").props.accessibilityState?.disabled,
    ).toBe(false);
    // The server's list did not change, so the sibling list has nothing to read.
    expect(onPendingSettled).not.toHaveBeenCalled();
  });

  it("KIN-MOBILE-001 R5: a decision the model dropped as stale settles nothing", async () => {
    let resolveDecision!: (reply: Reply) => void;
    const stalled = new Promise<Reply>((resolve) => {
      resolveDecision = resolve;
    });
    const only = approval("a1", "npm test --workspace api");
    const { fetchImpl, calls } = routedFetch((url) => {
      const pending = pendingReply([only])(url);
      if (pending) return pending;
      const thread = threadReply(url);
      if (thread) return thread;
      if (url === `${ORIGIN}/api/approvals/a1/decision`) return stalled;
      throw new Error(`unexpected request: ${url}`);
    });
    const onPendingSettled = jest.fn();
    const screen = await renderConversation(fetchImpl, onPendingSettled);

    await waitFor(() => expect(screen.getByTestId("approve:a1")).toBeTruthy());
    await fireEvent.press(screen.getByTestId("approve:a1"));
    await waitFor(() =>
      expect(
        calls.filter(
          (call) => call.url === `${ORIGIN}/api/approvals/a1/decision`,
        ),
      ).toHaveLength(1),
    );

    // Leaving disposes the model: the answer now belongs to a list that is
    // gone, and the model answers `stale` whatever the server says.
    await screen.unmount();
    await act(async () => {
      resolveDecision({ body: { ...only, decision: "approved" } });
      await Promise.resolve();
    });

    expect(onPendingSettled).not.toHaveBeenCalled();
  });
});
