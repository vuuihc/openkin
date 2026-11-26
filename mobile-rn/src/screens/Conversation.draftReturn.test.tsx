import { describe, expect, it, jest } from "@jest/globals";
import {
  act,
  fireEvent,
  render,
  waitFor,
} from "@testing-library/react-native";
import type { Task, TaskEvent } from "../../../ui/src/api/contract";
import type { Session } from "../auth/tokenStore";
import { createDraftMemory, type DraftMemory } from "../thread/draftMemory";
import type { StreamSource } from "../thread/stream";
import ConversationScreen from "./ConversationScreen";

/**
 * KIN-MOBILE-001 §5 离开再回来 — a draft outlives the conversation route.
 *
 * The signed story promises 「草稿、队列与滚动位置保留；不重复发送」
 * (docs/product/stories/KIN-MOBILE-001.md:103). The composer's text used to be
 * component state, so Back to the list unmounted it. This suite mounts the real
 * container, unmounts it and mounts it again with the same injected
 * `DraftMemory`: the reopening is the phone's pop-and-reopen, without a router.
 *
 * The Keychain and the network are injected, so nothing here touches either.
 */

const TASK_A = "task-a";
const TASK_B = "task-b";
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
    status: "succeeded",
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

function history(taskId: string): TaskEvent[] {
  return [
    event(taskId, 1, "message", {
      speaker: "user",
      role: "user",
      content: "run the tests",
      visibility: { user: true, task: true },
    }),
    event(taskId, 2, "message", {
      speaker: "kin",
      content: "all green",
      visibility: { user: true, task: true },
    }),
    event(taskId, 3, "result", { is_error: false }),
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

/**
 * Both conversations served from one router. A prompt accepts by default; a
 * case injects its own to refuse or to hold the post open.
 */
function conversations(
  options: {
    prompt?: (taskId: string) => Reply | Promise<Reply>;
  } = {},
): Router {
  return (url) => {
    const pending = noPending(url);
    if (pending) return pending;
    const route = taskRoute(url);
    if (route === null) return { body: {} };
    if (route.leaf === "prompt") {
      return options.prompt ? options.prompt(route.id) : { body: task(route.id) };
    }
    if (route.leaf === "events") return { body: history(route.id) };
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
 * A stream that opens and says nothing: these cases are about the composer,
 * and a real stream would make their routing fixtures answer an endpoint they
 * never meant to.
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
  draftMemory: DraftMemory,
) {
  return render(
    <ConversationScreen
      draftMemory={draftMemory}
      fetchImpl={fetchImpl}
      onBack={jest.fn()}
      readSessionImpl={storedSession}
      source={silentSource()}
      taskId={taskId}
    />,
  );
}

describe("KIN-MOBILE-001 §5 leaving and coming back", () => {
  it("KIN-MOBILE-001 §5 离开再回来: a draft survives the conversation unmounting and coming back", async () => {
    const memory = createDraftMemory();
    const { fetchImpl } = recordingFetch(conversations());

    const first = await renderConversation(fetchImpl, TASK_A, memory);
    await waitFor(() => expect(first.getByText("all green")).toBeTruthy());
    await fireEvent.changeText(
      first.getByTestId("conversation:composer"),
      "keep my words",
    );
    expect(memory.read(TASK_A)).toBe("keep my words");

    // Back to the list: the whole conversation route goes away.
    await first.unmount();

    // The same conversation opened again lands on the same memory.
    const reopened = await renderConversation(fetchImpl, TASK_A, memory);
    await waitFor(() => expect(reopened.getByText("all green")).toBeTruthy());
    expect(reopened.getByTestId("conversation:composer").props.value).toBe(
      "keep my words",
    );
  });

  it("KIN-MOBILE-001 §5 离开再回来: a sent draft is still cleared when the conversation is reopened", async () => {
    const memory = createDraftMemory();
    let releasePrompt!: (reply: Reply) => void;
    const held = new Promise<Reply>((resolve) => {
      releasePrompt = resolve;
    });
    const { fetchImpl, calls } = recordingFetch(
      conversations({ prompt: () => held }),
    );

    const first = await renderConversation(fetchImpl, TASK_A, memory);
    await waitFor(() => expect(first.getByText("all green")).toBeTruthy());
    await fireEvent.changeText(
      first.getByTestId("conversation:composer"),
      "already sent",
    );
    // Typing already keeps the words for a leave that happens before Send.
    expect(memory.read(TASK_A)).toBe("already sent");
    await fireEvent.press(first.getByTestId("conversation:send"));

    // The words go to the node, and the box and the memory let them go at
    // once — reopening must not bring back a message already on its way.
    await waitFor(() => expect(promptCalls(calls, TASK_A)).toHaveLength(1));
    expect(first.getByTestId("conversation:composer").props.value).toBe("");
    expect(memory.read(TASK_A)).toBe("");

    await act(async () => {
      releasePrompt({ body: task(TASK_A) });
      await new Promise((resolve) => setTimeout(resolve, 0));
    });
    expect(first.getByTestId("conversation:composer").props.value).toBe("");

    await first.unmount();

    const reopened = await renderConversation(fetchImpl, TASK_A, memory);
    await waitFor(() => expect(reopened.getByText("all green")).toBeTruthy());
    expect(reopened.getByTestId("conversation:composer").props.value).toBe("");
  });

  it("KIN-MOBILE-001 §5 离开再回来: another conversation never shows the first conversation's draft", async () => {
    const memory = createDraftMemory();
    const { fetchImpl } = recordingFetch(conversations());

    const first = await renderConversation(fetchImpl, TASK_A, memory);
    await waitFor(() => expect(first.getByText("all green")).toBeTruthy());
    await fireEvent.changeText(
      first.getByTestId("conversation:composer"),
      "only for A",
    );
    await first.unmount();

    // A different conversation reads its own entry, which is empty.
    const other = await renderConversation(fetchImpl, TASK_B, memory);
    await waitFor(() => expect(other.getByText("all green")).toBeTruthy());
    expect(other.getByTestId("conversation:composer").props.value).toBe("");
    await other.unmount();

    // A's words were never moved to B, and A still has them.
    const back = await renderConversation(fetchImpl, TASK_A, memory);
    await waitFor(() => expect(back.getByText("all green")).toBeTruthy());
    expect(back.getByTestId("conversation:composer").props.value).toBe(
      "only for A",
    );
  });

  it("KIN-MOBILE-001 §5 失败: a refused send's restored words also survive a leave", async () => {
    const memory = createDraftMemory();
    // A 500 is the node refusing the post; `api/transport.ts:97` maps every
    // 5xx to the `unreachable` reason.
    const { fetchImpl, calls } = recordingFetch(
      conversations({ prompt: () => ({ status: 500, body: {} }) }),
    );

    const first = await renderConversation(fetchImpl, TASK_A, memory);
    await waitFor(() => expect(first.getByText("all green")).toBeTruthy());
    await fireEvent.changeText(
      first.getByTestId("conversation:composer"),
      "这条不能丢",
    );
    await fireEvent.press(first.getByTestId("conversation:send"));

    await waitFor(() => expect(promptCalls(calls, TASK_A)).toHaveLength(1));
    // The refusal put the words back in the box; the memory is what a leave
    // would otherwise lose.
    await waitFor(() =>
      expect(first.getByTestId("conversation:composer").props.value).toBe(
        "这条不能丢",
      ),
    );
    expect(memory.read(TASK_A)).toBe("这条不能丢");

    await first.unmount();

    const reopened = await renderConversation(fetchImpl, TASK_A, memory);
    await waitFor(() => expect(reopened.getByText("all green")).toBeTruthy());
    expect(reopened.getByTestId("conversation:composer").props.value).toBe(
      "这条不能丢",
    );
    // Reopening reads the history; it never posts the restored words again.
    expect(promptCalls(calls, TASK_A)).toHaveLength(1);
  });
});
