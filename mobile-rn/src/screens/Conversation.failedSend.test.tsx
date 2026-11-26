import { describe, expect, it, jest } from "@jest/globals";
import {
  act,
  fireEvent,
  render,
  waitFor,
} from "@testing-library/react-native";
import type { Task, TaskEvent } from "../../../ui/src/api/contract";
import type { Session } from "../auth/tokenStore";
import type { StreamSource } from "../thread/stream";
import { t } from "../i18n";
import ConversationScreen from "./ConversationScreen";

/**
 * KIN-MOBILE-001 §5 失败 — a send the node refuses keeps the words.
 *
 * The story's execution cell promises 「失败：草稿留在 composer 并说明原因」
 * (docs/product/stories/KIN-MOBILE-001.md:101). The composer clears the box
 * as the words go to the model — that is what makes an accepted send feel
 * immediate — so the model's answer is what decides whether the words return:
 * `threadModel.send()` publishes the transport reason and answers
 * `{ ok: false, reason }`, and this suite is about the surface drawing that
 * answer as a restored draft plus one catalogue sentence.
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

function promptCalls(calls: RecordedCall[]): RecordedCall[] {
  return calls.filter((call) =>
    call.url.endsWith(`/api/tasks/${TASK_ID}/prompt`),
  );
}

function storedSession(): Promise<Session | null> {
  return Promise.resolve({ kind: "node", origin: ORIGIN, token: TOKEN });
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

async function renderConversation(fetchImpl: typeof fetch) {
  return render(
    <ConversationScreen
      fetchImpl={fetchImpl}
      onBack={jest.fn()}
      readSessionImpl={storedSession}
      source={silentSource()}
      taskId={TASK_ID}
    />,
  );
}

describe("KIN-MOBILE-001 §5 failed sends", () => {
  it("KIN-MOBILE-001 §5 失败: a refused send keeps the words and draws the reason", async () => {
    // A 500 is the node refusing to take the post; `api/transport.ts:97` maps
    // every 5xx to the `unreachable` reason, so the composer's one line is the
    // catalogue's sentence for that reason — the same sentence the offline
    // banner above the transcript speaks.
    const { fetchImpl, calls } = recordingFetch((url) => {
      const pending = noPending(url);
      if (pending) return pending;
      if (url.endsWith(`/api/tasks/${TASK_ID}/prompt`)) {
        return { status: 500, body: {} };
      }
      if (url.endsWith("/events")) return { body: HISTORY };
      return { body: task() };
    });
    const screen = await renderConversation(fetchImpl);
    await waitFor(() => expect(screen.getByText("all green")).toBeTruthy());

    await fireEvent.changeText(
      screen.getByTestId("conversation:composer"),
      "这条不能丢",
    );
    await fireEvent.press(screen.getByTestId("conversation:send"));

    // The post really was attempted and really was refused.
    await waitFor(() => expect(promptCalls(calls)).toHaveLength(1));
    await waitFor(() =>
      expect(screen.getByTestId("conversation:composer").props.value).toBe(
        "这条不能丢",
      ),
    );
    // One line, the catalogue's sentence for the reason the model reported.
    const line = screen.getByTestId("conversation:sendFailure");
    expect(line).toHaveTextContent(t("pairing.unreachable"));
    expect(line.props.accessibilityRole).toBe("alert");
  });

  it("KIN-MOBILE-001 §5 失败: an unreachable send keeps the words too", async () => {
    // The transport itself fails (no route, like a phone with no network):
    // `apiFetch` catches the rejection and reports the same `unreachable`
    // reason, which flips the banner to offline.
    const { fetchImpl, calls } = recordingFetch((url) => {
      const pending = noPending(url);
      if (pending) return pending;
      if (url.endsWith(`/api/tasks/${TASK_ID}/prompt`)) {
        throw new TypeError("Network request failed");
      }
      if (url.endsWith("/events")) return { body: HISTORY };
      return { body: task() };
    });
    const screen = await renderConversation(fetchImpl);
    await waitFor(() => expect(screen.getByText("all green")).toBeTruthy());

    await fireEvent.changeText(
      screen.getByTestId("conversation:composer"),
      "keep my words",
    );
    await fireEvent.press(screen.getByTestId("conversation:send"));

    await waitFor(() => expect(promptCalls(calls)).toHaveLength(1));
    // 断线: the offline banner is announced above the transcript …
    await waitFor(() =>
      expect(
        screen
          .getAllByText(t("pairing.unreachable"))
          .some((node) => node.props.accessibilityRole === "alert"),
      ).toBe(true),
    );
    // … the words are back in the box …
    await waitFor(() =>
      expect(screen.getByTestId("conversation:composer").props.value).toBe(
        "keep my words",
      ),
    );
    // … and the composer's own line explains why they stayed.
    expect(
      screen.getByTestId("conversation:sendFailure"),
    ).toHaveTextContent(t("pairing.unreachable"));
    // An offline node takes nothing: the restored words wait for the network.
    expect(
      screen.getByTestId("conversation:send").props.accessibilityState
        ?.disabled,
    ).toBe(true);
  });

  it("KIN-MOBILE-001 §5: a second tap while the post is in flight posts once", async () => {
    // The post stays open until the test releases it, so both taps happen
    // while the node has not answered.
    let releasePrompt!: (reply: Reply) => void;
    const held = new Promise<Reply>((resolve) => {
      releasePrompt = resolve;
    });
    const { fetchImpl, calls } = recordingFetch((url) => {
      const pending = noPending(url);
      if (pending) return pending;
      if (url.endsWith(`/api/tasks/${TASK_ID}/prompt`)) return held;
      if (url.endsWith("/events")) return { body: HISTORY };
      return { body: task() };
    });
    const screen = await renderConversation(fetchImpl);
    await waitFor(() => expect(screen.getByText("all green")).toBeTruthy());

    // The first tap posts the first thought and empties the box.
    await fireEvent.changeText(
      screen.getByTestId("conversation:composer"),
      "first thought",
    );
    await fireEvent.press(screen.getByTestId("conversation:send"));
    await waitFor(() => expect(promptCalls(calls)).toHaveLength(1));

    // The next thought is typed while the first post is still open. The tap
    // must post nothing: without the change it posted a second prompt here.
    await fireEvent.changeText(
      screen.getByTestId("conversation:composer"),
      "second thought",
    );
    await fireEvent.press(screen.getByTestId("conversation:send"));
    expect(promptCalls(calls)).toHaveLength(1);
    // The guard is the Send control's disabled state, not the empty box: the
    // words are here, and the control says it cannot take them yet.
    expect(
      screen.getByTestId("conversation:send").props.accessibilityState
        ?.disabled,
    ).toBe(true);

    // The node answers: the guard releases, the next thought was never posted,
    // and it is still the draft.
    await act(async () => {
      releasePrompt({ body: task() });
      await new Promise((resolve) => setTimeout(resolve, 0));
    });
    expect(promptCalls(calls)).toHaveLength(1);
    expect(screen.getByTestId("conversation:composer").props.value).toBe(
      "second thought",
    );
    expect(
      screen.getByTestId("conversation:send").props.accessibilityState
        ?.disabled,
    ).toBe(false);
  });

  it("KIN-MOBILE-001 §5: an accepted send still clears the box at once", async () => {
    // The shipped behaviour, and the reason the composer clears before the
    // post: the box is empty while the node has not answered yet.
    let releasePrompt!: (reply: Reply) => void;
    const held = new Promise<Reply>((resolve) => {
      releasePrompt = resolve;
    });
    const { fetchImpl, calls } = recordingFetch((url) => {
      const pending = noPending(url);
      if (pending) return pending;
      if (url.endsWith(`/api/tasks/${TASK_ID}/prompt`)) return held;
      if (url.endsWith("/events")) return { body: HISTORY };
      return { body: task() };
    });
    const screen = await renderConversation(fetchImpl);
    await waitFor(() => expect(screen.getByText("all green")).toBeTruthy());

    await fireEvent.changeText(
      screen.getByTestId("conversation:composer"),
      "also check the lint",
    );
    await fireEvent.press(screen.getByTestId("conversation:send"));
    await waitFor(() => expect(promptCalls(calls)).toHaveLength(1));

    // The node has not answered and the words are already on their way.
    expect(screen.getByTestId("conversation:composer").props.value).toBe("");
    expect(promptCalls(calls)[0].init.body).toBe(
      JSON.stringify({ prompt: "also check the lint" }),
    );

    await act(async () => {
      releasePrompt({ body: task() });
      await new Promise((resolve) => setTimeout(resolve, 0));
    });
    // Accepted: the box stays empty, and no failure line was drawn.
    expect(screen.getByTestId("conversation:composer").props.value).toBe("");
    expect(screen.queryByTestId("conversation:sendFailure")).toBeNull();
  });
});
