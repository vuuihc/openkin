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
import type { StreamSource } from "../thread/stream";
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
type RecordedCall = { url: string; init: RequestInit };

function routedFetch(route: Router): typeof fetch {
  return jest.fn(async (input: string, init?: RequestInit) => {
    const reply = await route(input, init);
    return ok(reply.body, reply.status ?? 200);
  }) as unknown as typeof fetch;
}

/**
 * The recording variant: every request's url and init, so a composer case can
 * assert the exact prompt or cancel the model posted — and that a queued or
 * withdrawn message posted nothing.
 */
function recordingFetch(
  route: Router,
  calls: RecordedCall[] = [],
): { fetchImpl: typeof fetch; calls: RecordedCall[] } {
  const impl = jest.fn(async (input: string, init?: RequestInit) => {
    calls.push({ url: input, init: init ?? {} });
    const reply = await route(input, init);
    return ok(reply.body, reply.status ?? 200);
  });
  return { fetchImpl: impl as unknown as typeof fetch, calls };
}

/** The node-wide pending lists are empty in every composer case. */
function noPending(url: string): Reply | undefined {
  if (url.endsWith("/api/approvals?status=pending")) return { body: [] };
  if (url.endsWith("/api/user-questions?status=pending")) return { body: [] };
  return undefined;
}

function promptCalls(calls: RecordedCall[]): RecordedCall[] {
  return calls.filter((call) =>
    call.url.endsWith(`/api/tasks/${TASK_ID}/prompt`),
  );
}

function cancelCalls(calls: RecordedCall[]): RecordedCall[] {
  return calls.filter((call) =>
    call.url.endsWith(`/api/tasks/${TASK_ID}/cancel`),
  );
}

// A round still going: no `result` has closed it, so the projection has a
// round the stop control can end.
const RUNNING_HISTORY: TaskEvent[] = [
  event(1, "message", {
    speaker: "user",
    role: "user",
    content: "run the tests",
    visibility: { user: true, task: true },
  }),
  event(2, "task_started"),
  event(3, "message", {
    speaker: "kin",
    content: "working on it",
    visibility: { user: true, task: true },
  }),
];

function storedSession(): Promise<Session | null> {
  return Promise.resolve({ origin: ORIGIN, token: TOKEN });
}

/** The default router: the task row and its event log, and the empty pending
 * lists the conversation has read beside them since R5c. */
function historyFetch(status: Task["status"] = "succeeded"): typeof fetch {
  return routedFetch((url) => {
    if (url.endsWith("/api/approvals?status=pending")) return { body: [] };
    if (url.endsWith("/api/user-questions?status=pending")) return { body: [] };
    return url.endsWith("/events")
      ? { body: HISTORY }
      : { body: task({ status }) };
  });
}

/**
 * A stream that opens and says nothing. The default here keeps every existing
 * case on its snapshot: those tests are about the surface, and a real stream
 * would make their routing fixtures answer an endpoint they never meant to.
 */
function silentSource(): StreamSource {
  return {
    async open() {
      return {
        status: 200,
        chunks: (async function* never(): AsyncGenerator<string> {
          await new Promise<void>(() => undefined);
        })(),
      };
    },
  };
}

/** A stream the test drives: each push is one decoded chunk. */
function controlledSource(): {
  source: StreamSource;
  opens: () => number;
  push: (chunk: string) => void;
} {
  const queue: string[] = [];
  let wake: (() => void) | null = null;
  let opens = 0;
  const chunks = (async function* feed(): AsyncGenerator<string> {
    for (;;) {
      if (queue.length === 0) {
        await new Promise<void>((resolve) => {
          wake = resolve;
        });
        continue;
      }
      const next = queue.shift();
      if (next !== undefined) yield next;
    }
  })();
  return {
    source: {
      async open() {
        opens += 1;
        return { status: 200, chunks };
      },
    },
    opens: () => opens,
    push(chunk) {
      queue.push(chunk);
      const resume = wake;
      wake = null;
      resume?.();
    },
  };
}

async function renderConversation(
  props: Partial<Parameters<typeof ConversationScreen>[0]> = {},
) {
  return render(
    <ConversationScreen
      fetchImpl={historyFetch()}
      onBack={jest.fn()}
      readSessionImpl={storedSession}
      source={silentSource()}
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

  it("KIN-MOBILE-001 R4: the screen subscribes, so an event after the snapshot is drawn", async () => {
    // The snapshot is not the conversation: a sent message, its reply and the
    // round's end arrive on `/api/events`. A container that only calls
    // `load()` shows the first frame forever; the simulator walk on
    // 2026-11-25 sent a message and watched "运行中" never clear.
    const live = controlledSource();
    const screen = await renderConversation({
      fetchImpl: historyFetch("running"),
      source: live.source,
    });
    await waitFor(() => expect(live.opens()).toBe(1));

    // The next contiguous seq: a skip is the gap-fill path, not this case.
    const reply = event(9, "message", {
      speaker: "kin",
      content: "answer that arrived over the stream",
      visibility: { user: true, task: true },
    });
    await act(async () => {
      live.push(
        `event: event\ndata: ${JSON.stringify({ kind: "event", data: reply })}\n\n`,
      );
      // The reader consumes a chunk through a microtask chain; let it finish
      // inside this act so its setState is not a warning.
      await new Promise((resolve) => setTimeout(resolve, 0));
    });

    await waitFor(() =>
      expect(
        screen.getByText("answer that arrived over the stream"),
      ).toBeTruthy(),
    );
  });

  it("KIN-MOBILE-001 R4: loading says so before the read answers, then the transcript replaces it", async () => {
    const pending: Array<(response: Response) => void> = [];
    const fetchImpl = jest.fn((url: string) => {
      // The pending lists are not this case's subject; answer them at once so
      // the two deferred reads below are exactly the task row and its log.
      if (url.endsWith("/api/approvals?status=pending")) {
        return Promise.resolve(ok([]));
      }
      if (url.endsWith("/api/user-questions?status=pending")) {
        return Promise.resolve(ok([]));
      }
      return new Promise<Response>((resolve) => {
        pending.push(resolve);
      });
    }) as unknown as typeof fetch;
    const screen = await renderConversation({ fetchImpl });

    // The first load draws the message area's shape; its container speaks the
    // one loading word (KIN-MOBILE-001 §3 slow state).
    await waitFor(() =>
      expect(screen.getByTestId("conversation-skeleton")).toBeTruthy(),
    );
    expect(
      screen.getByTestId("conversation-skeleton").props.accessibilityLabel,
    ).toBe(t("common.loading"));
    expect(pending).toHaveLength(2);

    await act(async () => {
      pending[0](ok(task()));
      pending[1](ok(HISTORY));
    });

    await waitFor(() => expect(screen.getByText("all green")).toBeTruthy());
    expect(screen.queryByTestId("conversation-skeleton")).toBeNull();
    expect(screen.queryByText(t("common.loading"))).toBeNull();
  });

  it("KIN-MOBILE-001 R4: a failed read shows the reason and retries", async () => {
    let calls = 0;
    const fetchImpl = routedFetch((url) => {
      // The conversation's pending lists answer normally; the count below is
      // about the task row and its log, which are what this case fails.
      if (url.endsWith("/api/approvals?status=pending")) return { body: [] };
      if (url.endsWith("/api/user-questions?status=pending")) return { body: [] };
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

  it("KIN-MOBILE-001 R4: the composer sends the typed message and clears the draft", async () => {
    let accepted = false;
    const route: Router = (url) => {
      const pending = noPending(url);
      if (pending) return pending;
      if (url.endsWith(`/api/tasks/${TASK_ID}/prompt`)) {
        accepted = true;
        return { body: task({ status: "running" }) };
      }
      if (url.endsWith("/events")) {
        return {
          body: accepted
            ? [
                ...HISTORY,
                event(9, "message", {
                  speaker: "user",
                  role: "user",
                  content: "also check the lint",
                  visibility: { user: true, task: true },
                }),
              ]
            : HISTORY,
        };
      }
      return { body: task({ status: accepted ? "running" : "succeeded" }) };
    };
    const first = recordingFetch(route);
    const screen = await renderConversation({ fetchImpl: first.fetchImpl });
    await waitFor(() => expect(screen.getByText("all green")).toBeTruthy());

    await fireEvent.changeText(
      screen.getByTestId("conversation:composer"),
      "also check the lint",
    );
    await fireEvent.press(screen.getByTestId("conversation:send"));

    await waitFor(() => expect(promptCalls(first.calls)).toHaveLength(1));
    const post = promptCalls(first.calls)[0];
    expect(post.init.method).toBe("POST");
    expect(post.init.body).toBe(
      JSON.stringify({ prompt: "also check the lint" }),
    );
    // The words left the composer as they went to the model.
    expect(screen.getByTestId("conversation:composer").props.value).toBe("");

    // The model publishes the accepted turn (a fresh read of the task); the
    // message is on screen and the draft stays empty across that publish.
    screen.rerender(
      <ConversationScreen
        fetchImpl={recordingFetch(route, first.calls).fetchImpl}
        onBack={jest.fn()}
        readSessionImpl={storedSession}
        taskId={TASK_ID}
      />,
    );
    await waitFor(() =>
      expect(screen.getByText("also check the lint")).toBeTruthy(),
    );
    expect(screen.getByTestId("conversation:composer").props.value).toBe("");
    // One send is one prompt: the publish did not post the text again.
    expect(promptCalls(first.calls)).toHaveLength(1);
  });

  it("KIN-MOBILE-001 R4: a send while a round runs is queued, shown, and can be withdrawn", async () => {
    const route: Router = (url) => {
      const pending = noPending(url);
      if (pending) return pending;
      if (url.endsWith("/events")) return { body: RUNNING_HISTORY };
      return { body: task({ status: "running" }) };
    };
    const { fetchImpl, calls } = recordingFetch(route);
    const screen = await renderConversation({ fetchImpl });
    await waitFor(() =>
      expect(screen.getByText(t("sessions.statusRunning"))).toBeTruthy(),
    );

    await fireEvent.changeText(
      screen.getByTestId("conversation:composer"),
      "then run the lint",
    );
    await fireEvent.press(screen.getByTestId("conversation:send"));

    // Queued: visible in the composer, and nothing was posted to the node.
    await waitFor(() =>
      expect(screen.getByText("then run the lint")).toBeTruthy(),
    );
    expect(promptCalls(calls)).toHaveLength(0);
    expect(screen.getByTestId("conversation:composer").props.value).toBe("");

    // Withdrawing is local too: the row goes and still nothing was posted.
    const withdraw = screen.getByTestId(/^conversation:withdraw:/);
    const style = StyleSheet.flatten(withdraw.props.style);
    expect(style.minHeight).toBeGreaterThanOrEqual(44);
    expect(style.minWidth).toBeGreaterThanOrEqual(44);
    await fireEvent.press(withdraw);
    await waitFor(() =>
      expect(screen.queryByText("then run the lint")).toBeNull(),
    );
    expect(promptCalls(calls)).toHaveLength(0);
  });

  it("KIN-MOBILE-001 R4: stopping a running round posts the cancel and the stopped note stays", async () => {
    let stopped = false;
    const route: Router = (url) => {
      const pending = noPending(url);
      if (pending) return pending;
      if (url.endsWith(`/api/tasks/${TASK_ID}/cancel`)) {
        stopped = true;
        return { body: task({ status: "canceled" }) };
      }
      if (url.endsWith("/events")) return { body: RUNNING_HISTORY };
      return { body: task({ status: stopped ? "canceled" : "running" }) };
    };
    const first = recordingFetch(route);
    const screen = await renderConversation({ fetchImpl: first.fetchImpl });
    await waitFor(() =>
      expect(screen.getByText(t("sessions.statusRunning"))).toBeTruthy(),
    );

    await fireEvent.press(screen.getByTestId("conversation:stop"));

    await waitFor(() => expect(cancelCalls(first.calls)).toHaveLength(1));
    await waitFor(() =>
      expect(screen.getByText(t("chat.stoppedNote"))).toBeTruthy(),
    );

    // The note is the task's durable status, not a transient banner: a later
    // publish from the model (a fresh read) still has it, and the screen did
    // not post a second cancel to get it.
    screen.rerender(
      <ConversationScreen
        fetchImpl={recordingFetch(route, first.calls).fetchImpl}
        onBack={jest.fn()}
        readSessionImpl={storedSession}
        taskId={TASK_ID}
      />,
    );
    await waitFor(() => expect(screen.getByText("working on it")).toBeTruthy());
    expect(screen.getByText(t("chat.stoppedNote"))).toBeTruthy();
    expect(cancelCalls(first.calls)).toHaveLength(1);
  });

  it("KIN-MOBILE-001 R4: offline keeps the draft, disables sending and says why", async () => {
    // Every request fails the way a phone with no route fails: the read is
    // unreachable, so the screen is offline with the pairing sentence.
    const { fetchImpl, calls } = recordingFetch(() =>
      Promise.reject(new TypeError("Network request failed")),
    );
    const screen = await renderConversation({ fetchImpl });

    await waitFor(() =>
      expect(
        screen.getAllByText(t("pairing.unreachable")).length,
      ).toBeGreaterThan(0),
    );
    // The reason is announced, not only drawn: the view's existing alert.
    expect(
      screen
        .getAllByText(t("pairing.unreachable"))
        .some((node) => node.props.accessibilityRole === "alert"),
    ).toBe(true);

    await fireEvent.changeText(
      screen.getByTestId("conversation:composer"),
      "keep my words",
    );
    const send = screen.getByTestId("conversation:send");
    expect(send.props.accessibilityState?.disabled).toBe(true);
    await fireEvent.press(send);
    expect(promptCalls(calls)).toHaveLength(0);

    // A later publish — the failed re-read behind the retry — does not lose
    // what the person typed.
    const reads = (): RecordedCall[] =>
      calls.filter((call) => call.url.endsWith("/events"));
    const before = reads().length;
    // The view's own retry: the approvals section draws one too when every
    // read failed, and this case is about the thread's.
    await fireEvent.press(screen.getByTestId("conversation:retry"));
    await waitFor(() => expect(reads().length).toBeGreaterThan(before));
    await waitFor(() =>
      expect(screen.getByTestId("conversation:composer").props.value).toBe(
        "keep my words",
      ),
    );
    expect(promptCalls(calls)).toHaveLength(0);
  });

  it("KIN-MOBILE-001 R4: the composer's controls meet the 44pt floor", async () => {
    const onSend = jest.fn();
    const onStop = jest.fn();
    const onWithdraw = jest.fn();
    const screen = await render(
      <ConversationView
        onBack={jest.fn()}
        onSend={onSend}
        onStop={onStop}
        onWithdraw={onWithdraw}
        state={readyState({
          running: true,
          sendQueue: [{ id: "q1", text: "a follow-up" }],
        })}
        t={t}
      />,
    );

    for (const testID of [
      "conversation:send",
      "conversation:stop",
      "conversation:withdraw:q1",
    ]) {
      const style = StyleSheet.flatten(screen.getByTestId(testID).props.style);
      expect(style.minHeight).toBeGreaterThanOrEqual(44);
      expect(style.minWidth).toBeGreaterThanOrEqual(44);
    }

    await fireEvent.press(screen.getByTestId("conversation:stop"));
    expect(onStop).toHaveBeenCalledTimes(1);
    await fireEvent.press(screen.getByTestId("conversation:withdraw:q1"));
    expect(onWithdraw).toHaveBeenCalledWith("q1");
  });
});
