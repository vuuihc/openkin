import { describe, expect, it, jest } from "@jest/globals";
import {
  act,
  fireEvent,
  render,
  waitFor,
} from "@testing-library/react-native";
import type { Task, TaskEvent } from "../../../ui/src/api/contract";
import type { Session } from "../auth/tokenStore";
import { createQueueMemory, type QueueMemory } from "../thread/queueMemory";
import type { StreamSource } from "../thread/stream";
import ConversationScreen from "./ConversationScreen";

/**
 * KIN-MOBILE-001 §5 离开再回来 — a queued send outlives the conversation route.
 *
 * The signed story promises 「草稿、队列与滚动位置保留；不重复发送」
 * (docs/product/stories/KIN-MOBILE-001.md:103). The queue lives in the thread
 * model, and Back unmounts that model. This suite mounts the real container,
 * queues while a round runs, unmounts it and mounts it again with the same
 * injected `QueueMemory`: the reopening is the phone's pop-and-reopen, without
 * a router. A model-only case would stay green while the screen forgot to hand
 * the shared store to its thread, so this is the container's own proof.
 *
 * The Keychain and the network are injected, so nothing here touches either.
 */

const TASK_A = "task-a";
const ORIGIN = "https://kin.example.com";
const TOKEN = "test-token";

function task(id: string, overrides: Partial<Task> = {}): Task {
  return {
    id,
    title: "A conversation",
    agent: "kin",
    cwd: "/work",
    prompt: "hello",
    model: "model-x",
    status: "running",
    tokens_in: 0,
    tokens_out: 0,
    created_at: 1,
    event_epoch: 0,
    ...overrides,
  };
}

function event(
  taskId: string,
  seq: number,
  type = "message",
  payload: TaskEvent["payload"] = {},
): TaskEvent {
  return {
    task_id: taskId,
    event_epoch: 0,
    seq,
    ts: 1_000 + seq,
    type,
    payload,
  };
}

/** A round still going: no `result` has closed it. */
function runningHistory(taskId: string): TaskEvent[] {
  return [
    event(taskId, 1, "message", {
      speaker: "user",
      role: "user",
      content: "run the tests",
      visibility: { user: true, task: true },
    }),
    event(taskId, 2, "task_started"),
    event(taskId, 3, "message", {
      speaker: "kin",
      content: "working on it",
      visibility: { user: true, task: true },
    }),
  ];
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

/** Records every request's url and init, so the case can count prompt POSTs. */
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

/** `/api/tasks/:id`, `…/events` and `…/prompt`, without the query string. */
function taskRoute(
  url: string,
): { id: string; leaf: "" | "events" | "prompt" } | null {
  const query = url.indexOf("?");
  const path = query === -1 ? url : url.slice(0, query);
  const marker = "/api/tasks/";
  const at = path.indexOf(marker);
  if (at === -1) return null;
  const parts = path.slice(at + marker.length).split("/");
  if (parts.length === 1) return { id: parts[0], leaf: "" };
  if (parts.length === 2 && (parts[1] === "events" || parts[1] === "prompt")) {
    return { id: parts[0], leaf: parts[1] };
  }
  return null;
}

function conversation(): Router {
  return (url) => {
    const pending = noPending(url);
    if (pending) return pending;
    const route = taskRoute(url);
    if (route === null) return { body: {} };
    if (route.leaf === "prompt") return { body: task(route.id) };
    if (route.leaf === "events") return { body: runningHistory(route.id) };
    return { body: task(route.id) };
  };
}

function promptCalls(calls: RecordedCall[], taskId: string): RecordedCall[] {
  return calls.filter((call) =>
    call.url.endsWith(`/api/tasks/${taskId}/prompt`),
  );
}

function storedSession(): Promise<Session | null> {
  return Promise.resolve({ origin: ORIGIN, token: TOKEN });
}

/**
 * A stream that opens and says nothing: these cases are about the queue, and
 * the running round is already in the history the read answers with.
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

function renderConversation(
  fetchImpl: typeof fetch,
  taskId: string,
  queueMemory: QueueMemory,
) {
  return render(
    <ConversationScreen
      fetchImpl={fetchImpl}
      onBack={jest.fn()}
      queueMemory={queueMemory}
      readSessionImpl={storedSession}
      source={silentSource()}
      taskId={taskId}
    />,
  );
}

describe("KIN-MOBILE-001 §5 leaving and coming back", () => {
  it("KIN-MOBILE-001 §5 离开再回来: the queued rows are still drawn after the conversation remounts", async () => {
    const memory = createQueueMemory();
    const { fetchImpl, calls } = recordingFetch(conversation());

    const first = await renderConversation(fetchImpl, TASK_A, memory);
    await waitFor(() => expect(first.getByText("working on it")).toBeTruthy());
    await fireEvent.changeText(
      first.getByTestId("conversation:composer"),
      "then run the lint",
    );
    await fireEvent.press(first.getByTestId("conversation:send"));

    // Queued while the round runs: the row is drawn and nothing was posted.
    await waitFor(() =>
      expect(first.getByText("then run the lint")).toBeTruthy(),
    );
    const queuedRow = first.getByTestId(/^conversation:withdraw:/);
    expect(promptCalls(calls, TASK_A)).toHaveLength(0);
    expect(memory.read(TASK_A).map((item) => item.text)).toEqual([
      "then run the lint",
    ]);

    // Back to the list: the whole conversation route goes away.
    await first.unmount();

    // The same conversation opened again still owes the same words, drawn as
    // a queue row rather than a transcript bubble, and still withdrawable by
    // the id it had before the leave.
    const reopened = await renderConversation(fetchImpl, TASK_A, memory);
    await waitFor(() => expect(reopened.getByText("working on it")).toBeTruthy());
    expect(reopened.getByText("then run the lint")).toBeTruthy();
    expect(reopened.getByTestId(queuedRow.props.testID)).toBeTruthy();
    // Reopening reads the conversation; it never posts the queued words again.
    expect(promptCalls(calls, TASK_A)).toHaveLength(0);
  });
});
