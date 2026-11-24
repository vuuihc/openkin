import { describe, expect, it, jest } from "@jest/globals";
import {
  act,
  fireEvent,
  render,
  waitFor,
} from "@testing-library/react-native";
import { StyleSheet } from "react-native";
import type { Task, TaskEvent } from "../../../ui/src/api/contract";
import {
  projectThread,
  type ThreadState,
} from "../thread/threadModel";
import type {
  ChatItem,
  Turn,
} from "../../../ui/src/components/chat/transcriptProjection";
import type { Session } from "../auth/tokenStore";
import { t } from "../i18n";
import ConversationScreen from "./ConversationScreen";
import ConversationView from "./ConversationView";

/**
 * KIN-MOBILE-001 R4b — the phone's read-only conversation.
 *
 * The projection itself is proven in `threadModel.test.ts`; this suite is
 * about the surface: does the view draw exactly the turns the shared
 * projection produced, does a loading read say so, does a failed read offer a
 * retry that re-reads, is the running state told, and is the back control a
 * signed 44pt target.
 *
 * The Keychain and the network are injected, so nothing here touches either.
 */

const TASK_ID = "task-1";
const ORIGIN = "https://kin.example.com";
const TOKEN = "test-token";

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

// One history with every shape the view has to draw: the ask, a standalone
// error, then an agent turn carrying a reasoning note and a tool call before
// its answer.
const HISTORY: TaskEvent[] = [
  event(1, "message", {
    speaker: "user",
    role: "user",
    content: "run the tests",
    visibility: { user: true, task: true },
  }),
  event(2, "error", { message: "the suite did not finish" }),
  event(3, "task_started"),
  event(4, "message", {
    speaker: "kin",
    role: "reasoning",
    content: [{ type: "text", text: "checking the failing suite" }],
    partial: true,
    phase: "progress",
  }),
  event(5, "tool_use", {
    speaker: "kin",
    tool_use_id: "call-1",
    name: "bash",
    input: { command: "npm test" },
    visibility: { user: true, task: true },
  }),
  event(6, "tool_result", {
    speaker: "kin",
    tool_use_id: "call-1",
    name: "bash",
    output: "ok",
    ok: true,
    visibility: { user: true, task: true },
  }),
  event(7, "message", {
    speaker: "kin",
    content: "all green",
    visibility: { user: true, task: true },
  }),
  event(8, "result", { is_error: false }),
];

/** Every string a turn speaks, read from the shared projection itself. */
function spokenTexts(turns: readonly Turn[]): string[] {
  const fromItem = (item: ChatItem): string[] => {
    switch (item.kind) {
      case "message":
        return [item.text];
      case "error":
        return [item.message];
      case "meta":
        return [item.label];
      case "compaction":
        return [item.text];
      case "progress":
        return item.steps.flatMap((step) =>
          step.kind === "note" ? [step.text] : [step.name],
        );
    }
  };
  return turns.flatMap((turn) =>
    turn.kind === "agent"
      ? turn.items.flatMap(fromItem)
      : fromItem(turn.item),
  );
}

function ok(body: unknown, status = 200): Response {
  return {
    ok: status >= 200 && status < 300,
    status,
    json: async () => body,
  } as unknown as Response;
}

type Reply = { status?: number; body: unknown };
type Router = (url: string, init?: RequestInit) => Reply | Promise<Reply>;

function routedFetch(route: Router): typeof fetch {
  return jest.fn(async (input: string, init?: RequestInit) => {
    const reply = await route(input, init);
    return ok(reply.body, reply.status ?? 200);
  }) as unknown as typeof fetch;
}

function storedSession(): Promise<Session | null> {
  return Promise.resolve({ origin: ORIGIN, token: TOKEN });
}

/** The default router: the task row and its event log. */
function historyFetch(status: Task["status"] = "succeeded"): typeof fetch {
  return routedFetch((url) =>
    url.endsWith("/events")
      ? { body: HISTORY }
      : { body: task({ status }) },
  );
}

async function renderConversation(
  props: Partial<Parameters<typeof ConversationScreen>[0]> = {},
) {
  return render(
    <ConversationScreen
      fetchImpl={historyFetch()}
      onBack={jest.fn()}
      readSessionImpl={storedSession}
      taskId={TASK_ID}
      {...props}
    />,
  );
}

function readyState(overrides: Partial<ThreadState> = {}): ThreadState {
  return {
    taskId: TASK_ID,
    status: "ready",
    turns: [],
    running: false,
    sendQueue: [],
    banner: null,
    reason: null,
    ...overrides,
  };
}

describe("KIN-MOBILE-001 R4 conversation", () => {
  it("KIN-MOBILE-001 R4: history renders grouped as the shared projection groups it", async () => {
    const screen = await renderConversation();
    const expected = spokenTexts(projectThread(HISTORY, task()));
    // Guard the fixture itself: without these the assertion below would pass
    // over an empty transcript.
    expect(expected).toContain("run the tests");
    expect(expected).toContain("the suite did not finish");
    expect(expected).toContain("checking the failing suite");
    expect(expected).toContain("bash");
    expect(expected).toContain("all green");

    await waitFor(() => expect(screen.getByText("all green")).toBeTruthy());
    for (const text of expected) {
      expect(screen.getByText(text)).toBeTruthy();
    }
  });

  it("KIN-MOBILE-001 R4: loading says so before the read answers, then the transcript replaces it", async () => {
    const pending: Array<(response: Response) => void> = [];
    const fetchImpl = jest.fn(
      () =>
        new Promise<Response>((resolve) => {
          pending.push(resolve);
        }),
    ) as unknown as typeof fetch;
    const screen = await renderConversation({ fetchImpl });

    await waitFor(() =>
      expect(screen.getByText(t("common.loading"))).toBeTruthy(),
    );
    expect(pending).toHaveLength(2);

    await act(async () => {
      pending[0](ok(task()));
      pending[1](ok(HISTORY));
    });

    await waitFor(() => expect(screen.getByText("all green")).toBeTruthy());
    expect(screen.queryByText(t("common.loading"))).toBeNull();
  });

  it("KIN-MOBILE-001 R4: a failed read shows the reason and retries", async () => {
    let calls = 0;
    const fetchImpl = routedFetch((url) => {
      calls += 1;
      if (calls <= 2) return { status: 500, body: {} };
      return url.endsWith("/events")
        ? { body: HISTORY }
        : { body: task() };
    });
    const screen = await renderConversation({ fetchImpl });

    await waitFor(() =>
      expect(
        screen.getByText(t("pairing.unreachable")),
      ).toBeTruthy(),
    );
    expect(calls).toBe(2);

    await fireEvent.press(screen.getByText(t("pairing.retry")));
    await waitFor(() => expect(calls).toBe(4));
    await waitFor(() => expect(screen.getByText("all green")).toBeTruthy());
    expect(screen.queryByText(t("pairing.unreachable"))).toBeNull();
  });

  it("KIN-MOBILE-001 R4: a running task shows the running indicator and a terminal one does not", async () => {
    const running = await renderConversation({
      fetchImpl: historyFetch("running"),
    });
    await waitFor(() => expect(running.getByText("all green")).toBeTruthy());
    expect(running.getByText(t("sessions.statusRunning"))).toBeTruthy();
    await running.unmount();

    const settled = await renderConversation({
      fetchImpl: historyFetch("succeeded"),
    });
    await waitFor(() => expect(settled.getByText("all green")).toBeTruthy());
    expect(settled.queryByText(t("sessions.statusRunning"))).toBeNull();
  });

  it("KIN-MOBILE-001 R4: the back control is 44pt and calls onBack", async () => {
    const onBack = jest.fn();
    const screen = await render(
      <ConversationView onBack={onBack} state={readyState()} t={t} />,
    );
    const control = screen.getByTestId("conversation:back");
    const style = StyleSheet.flatten(control.props.style);
    expect(style.minHeight).toBeGreaterThanOrEqual(44);
    expect(style.minWidth).toBeGreaterThanOrEqual(44);

    await fireEvent.press(control);
    expect(onBack).toHaveBeenCalledTimes(1);
  });
});
