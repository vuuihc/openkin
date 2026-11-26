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
 * KIN-MOBILE-001 §5 慢 — the composer's Send control shows it is sending.
 *
 * The story's slow cell promises 「慢：发送按钮转圈但草稿仍可编辑」
 * (docs/product/stories/KIN-MOBILE-001.md:101). The composer already held the
 * state (`sending`, ConversationView.tsx:499) and closed the control while a
 * post was in flight, but the send control kept the word 发送 and drew no
 * waiting cue at all: the platform `ActivityIndicator` is the project's only
 * one (ConversationScreen.tsx:368), and before this suite it appeared nowhere
 * in ConversationView.tsx. The catalogue sentence already exists —
 * `composer.sending` = 「正在发送…」 (ui/src/i18n/locales/zh.ts:314,
 * ui/src/i18n/locales/en.ts:332) — so this suite adds no string.
 *
 * The post is held on a promise that does not settle until the case releases
 * it, which is the slow node the cell is about. The Keychain and the network
 * are injected, so nothing here touches either.
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

/**
 * A `/prompt` route that answers only when the case says so: the promise the
 * server never answers is the slow node the §5 慢 cell describes.
 */
function heldPrompt(): {
  fetchImpl: typeof fetch;
  calls: RecordedCall[];
  release: (reply: Reply) => void;
} {
  let release!: (reply: Reply) => void;
  const held = new Promise<Reply>((resolve) => {
    release = resolve;
  });
  const { fetchImpl, calls } = recordingFetch((url) => {
    const pending = noPending(url);
    if (pending) return pending;
    if (url.endsWith(`/api/tasks/${TASK_ID}/prompt`)) return held;
    if (url.endsWith("/events")) return { body: HISTORY };
    return { body: task() };
  });
  return { fetchImpl, calls, release };
}

/** Lets the released reply run through the composer's `settle`. */
async function settleHeld(release: (reply: Reply) => void, reply: Reply) {
  await act(async () => {
    release(reply);
    await new Promise((resolve) => setTimeout(resolve, 0));
  });
}

describe("KIN-MOBILE-001 §5 slow sends", () => {
  it("KIN-MOBILE-001 §5 慢: a post in flight draws the sending indicator", async () => {
    const { fetchImpl, calls, release } = heldPrompt();
    const screen = await renderConversation(fetchImpl);
    await waitFor(() => expect(screen.getByText("all green")).toBeTruthy());

    await fireEvent.changeText(
      screen.getByTestId("conversation:composer"),
      "on its way",
    );
    await fireEvent.press(screen.getByTestId("conversation:send"));
    await waitFor(() => expect(promptCalls(calls)).toHaveLength(1));

    // The node has not answered, and the control says so: the platform
    // indicator stands where 发送 stood, speaking the catalogue's sentence.
    const cue = screen.getByTestId("conversation:sending");
    expect(cue.props.accessibilityLabel).toBe(t("composer.sending"));
    // The word keeps the control's width but leaves the reader: the text
    // query follows the accessibility tree, so 发送 is gone while the cue is
    // up and a screen reader hears 正在发送… only.
    expect(screen.queryByText(t("composer.send"))).toBeNull();
    // The control is closed to a second post and announced as busy.
    expect(
      screen.getByTestId("conversation:send").props.accessibilityState,
    ).toEqual({ disabled: true, busy: true });

    await settleHeld(release, { body: task() });
  });

  it("KIN-MOBILE-001 §5 慢: the draft stays editable while the post is in flight", async () => {
    const { fetchImpl, calls, release } = heldPrompt();
    const screen = await renderConversation(fetchImpl);
    await waitFor(() => expect(screen.getByText("all green")).toBeTruthy());

    await fireEvent.changeText(
      screen.getByTestId("conversation:composer"),
      "first thought",
    );
    await fireEvent.press(screen.getByTestId("conversation:send"));
    await waitFor(() => expect(promptCalls(calls)).toHaveLength(1));
    expect(screen.getByTestId("conversation:sending")).toBeTruthy();

    // The box takes the next thought while the first post is still open: the
    // cue must not cost the person their draft.
    await fireEvent.changeText(
      screen.getByTestId("conversation:composer"),
      "next thought",
    );
    expect(screen.getByTestId("conversation:composer").props.value).toBe(
      "next thought",
    );
    // The next thought is in the box, but the post in flight still owns the
    // control.
    expect(
      screen.getByTestId("conversation:send").props.accessibilityState
        ?.disabled,
    ).toBe(true);

    // The node refuses the first post: the cue clears, the reason is drawn,
    // and the newer thought is still the draft — not the refused words.
    await settleHeld(release, { status: 500, body: {} });
    await waitFor(() =>
      expect(screen.queryByTestId("conversation:sending")).toBeNull(),
    );
    expect(
      screen.getByTestId("conversation:sendFailure"),
    ).toHaveTextContent(t("pairing.unreachable"));
    expect(screen.getByTestId("conversation:composer").props.value).toBe(
      "next thought",
    );
  });

  it("KIN-MOBILE-001 §5 慢: the indicator clears when the post settles", async () => {
    const { fetchImpl, calls, release } = heldPrompt();
    const screen = await renderConversation(fetchImpl);
    await waitFor(() => expect(screen.getByText("all green")).toBeTruthy());

    await fireEvent.changeText(
      screen.getByTestId("conversation:composer"),
      "also check the lint",
    );
    await fireEvent.press(screen.getByTestId("conversation:send"));
    await waitFor(() => expect(promptCalls(calls)).toHaveLength(1));
    expect(screen.getByTestId("conversation:sending")).toBeTruthy();

    await settleHeld(release, { body: task() });
    // Accepted: no cue is left behind, and the control is the one it always
    // was — the catalogue's 发送 label, not a permanent spinner.
    await waitFor(() =>
      expect(screen.queryByTestId("conversation:sending")).toBeNull(),
    );
    expect(screen.getByText(t("composer.send"))).toBeTruthy();
  });
});
