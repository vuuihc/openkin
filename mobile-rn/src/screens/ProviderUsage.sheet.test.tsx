import { beforeEach, describe, expect, it, jest } from "@jest/globals";
import {
  act,
  fireEvent,
  render,
  waitFor,
} from "@testing-library/react-native";
import { StyleSheet } from "react-native";
import type {
  ProviderEntry,
  UsageRow,
} from "../providers/providersModel";
import type { Session } from "../auth/tokenStore";
import { t } from "../i18n";
import ConversationScreen from "./ConversationScreen";

/**
 * KIN-MOBILE-001 R6 (part 2) — the conversation mounts the provider/usage sheet.
 *
 * R6's screen is proven in `ProviderUsage.test.tsx` and its model in
 * `providersModel.test.ts`. This suite is about the mount: the conversation
 * header's 用量 entry opens the sheet, opening reads the node once, closing
 * returns to the same (never re-read) transcript and abandons an in-flight
 * read, the chosen window survives close-and-reopen in session memory (no
 * storage write), a conversation with no stored session draws no entry, and
 * the empty device's words come through the sheet unchanged (AGENTS.md §11).
 *
 * The Keychain and the network are injected, so nothing here touches either.
 */

const mockSetItem = jest.fn(async (): Promise<void> => {});
jest.mock("expo-secure-store", () => ({
  getItemAsync: jest.fn(async () => null),
  setItemAsync: (...args: unknown[]) => mockSetItem(...(args as [])),
  deleteItemAsync: jest.fn(async () => {}),
}));

const TASK_ID = "task-1";
const ORIGIN = "https://kin.example.com";
const TOKEN = "fixture-token";

const PROVIDER: ProviderEntry = {
  id: "provider-primary",
  name: "Primary fixture",
  kind: "openai-compatible",
  base_url: "https://llm.example.com/v1",
  model: "fixture-large",
  stream: true,
  active: true,
};

function usageRow(overrides: Partial<UsageRow> = {}): UsageRow {
  return {
    date: "2026-11-20",
    agent: "planner",
    tasks: 2,
    tokens_in: 1000,
    tokens_out: 500,
    cost_usd: 0.03,
    request_count: 4,
    reasoning_output_tokens: 0,
    cache_read_tokens: 300,
    cache_write_tokens: 0,
    cache_eligible_input_tokens: 1200,
    cache_hit_rate: 0.25,
    cache_coverage: 1,
    cache_status: "reported",
    ...overrides,
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

const TASK = {
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
};

const HISTORY = [
  {
    task_id: TASK_ID,
    event_epoch: 0,
    seq: 1,
    ts: 1_001,
    type: "message",
    payload: {
      speaker: "user",
      role: "user",
      content: "run the tests",
      visibility: { user: true, task: true },
    },
  },
  {
    task_id: TASK_ID,
    event_epoch: 0,
    seq: 2,
    ts: 1_002,
    type: "message",
    payload: {
      speaker: "kin",
      content: "all green",
      visibility: { user: true, task: true },
    },
  },
];

/** The conversation's own read: one task row and its event log. */
function threadReply(url: string): Reply | undefined {
  if (url === `${ORIGIN}/api/tasks/${TASK_ID}/events`) return { body: HISTORY };
  if (url === `${ORIGIN}/api/tasks/${TASK_ID}`) return { body: TASK };
  return undefined;
}

/** The node-wide pending lists the conversation reads beside the thread. */
function pendingReply(url: string): Reply | undefined {
  if (url === `${ORIGIN}/api/approvals?status=pending`) return { body: [] };
  if (url === `${ORIGIN}/api/user-questions?status=pending`) return { body: [] };
  return undefined;
}

function storedSession(): Promise<Session | null> {
  return Promise.resolve({ origin: ORIGIN, token: TOKEN });
}

function noSession(): Promise<Session | null> {
  return Promise.resolve(null);
}

async function renderConversation(
  fetchImpl: typeof fetch,
  readSessionImpl: () => Promise<Session | null> = storedSession,
) {
  return render(
    <ConversationScreen
      fetchImpl={fetchImpl}
      onBack={jest.fn()}
      readSessionImpl={readSessionImpl}
      taskId={TASK_ID}
    />,
  );
}

/** A router that answers the conversation and the sheet's two reads. */
function usageRouter(
  providers: ProviderEntry[] = [PROVIDER],
  usage: UsageRow[] = [usageRow()],
): Router {
  return (url) => {
    const thread = threadReply(url);
    if (thread) return thread;
    const pending = pendingReply(url);
    if (pending) return pending;
    if (url === `${ORIGIN}/api/providers`) {
      return { body: { active_id: providers[0]?.id ?? "", providers } };
    }
    if (url.startsWith(`${ORIGIN}/api/usage/summary`)) {
      return { body: usage };
    }
    throw new Error(`unexpected request: ${url}`);
  };
}

function usageReads(calls: Call[]): Call[] {
  return calls.filter((call) =>
    call.url.startsWith(`${ORIGIN}/api/usage/summary`),
  );
}

function threadReads(calls: Call[]): Call[] {
  return calls.filter(
    (call) => call.url === `${ORIGIN}/api/tasks/${TASK_ID}/events`,
  );
}

/** Settle the conversation: the transcript and both pending lists answered. */
async function settled(screen: Awaited<ReturnType<typeof render>>) {
  await waitFor(() => expect(screen.getByText("all green")).toBeTruthy());
  await waitFor(() =>
    expect(screen.queryByText(t("inbox.loading"))).toBeNull(),
  );
}

describe("KIN-MOBILE-001 R6 provider/usage sheet mount", () => {
  beforeEach(() => {
    mockSetItem.mockClear();
  });

  it("KIN-MOBILE-001 R6: the conversation header opens the usage sheet and closing it returns to the same conversation", async () => {
    const { fetchImpl, calls } = routedFetch(usageRouter());
    const screen = await renderConversation(fetchImpl);
    await settled(screen);

    // Lazy read: the conversation itself asks the node nothing about usage.
    expect(
      calls.filter((call) => call.url === `${ORIGIN}/api/providers`),
    ).toHaveLength(0);

    const entry = screen.getByTestId("conversation:usage");
    expect(entry.props.accessibilityLabel).toBe(t("usage.openPhone"));
    expect(entry.props.accessibilityRole).toBe("button");
    // The signed touch floor (TASTE 11).
    const style = StyleSheet.flatten(entry.props.style);
    expect(style.minHeight ?? 0).toBeGreaterThanOrEqual(44);
    expect(style.minWidth ?? 0).toBeGreaterThanOrEqual(44);

    await fireEvent.press(entry);

    await waitFor(() =>
      expect(screen.getByTestId("provider-usage-screen")).toBeTruthy(),
    );
    // Exactly one providers read, and the transcript is still under the sheet.
    expect(
      calls.filter((call) => call.url === `${ORIGIN}/api/providers`),
    ).toHaveLength(1);
    expect(screen.getByText("all green")).toBeTruthy();
    // Opening did not remount or re-read the conversation.
    expect(threadReads(calls)).toHaveLength(1);

    await fireEvent.press(screen.getByTestId("usage-close"));

    await waitFor(() =>
      expect(screen.queryByTestId("provider-usage-screen")).toBeNull(),
    );
    expect(screen.getByText("all green")).toBeTruthy();
    // The scroller and the thread model were never rebuilt: no second read.
    expect(threadReads(calls)).toHaveLength(1);
    expect(screen.getByTestId("conversation:usage")).toBeTruthy();
  });

  it("KIN-MOBILE-001 R6: the sheet's window choice survives close and reopen in the same session", async () => {
    const { fetchImpl, calls } = routedFetch(usageRouter());
    const screen = await renderConversation(fetchImpl);
    await settled(screen);

    await fireEvent.press(screen.getByTestId("conversation:usage"));
    await waitFor(() =>
      expect(screen.getByTestId("provider-usage-screen")).toBeTruthy(),
    );
    await waitFor(() =>
      expect(
        screen.getByTestId("usage-window:30").props.accessibilityState?.selected,
      ).toBe(true),
    );

    await fireEvent.press(screen.getByTestId("usage-window:7"));
    await waitFor(() =>
      expect(
        screen.getByTestId("usage-window:7").props.accessibilityState?.selected,
      ).toBe(true),
    );
    await waitFor(() =>
      expect(
        usageReads(calls).filter((call) => call.url.endsWith("?days=7")),
      ).toHaveLength(1),
    );

    await fireEvent.press(screen.getByTestId("usage-close"));
    await waitFor(() =>
      expect(screen.queryByTestId("provider-usage-screen")).toBeNull(),
    );

    await fireEvent.press(screen.getByTestId("conversation:usage"));
    await waitFor(() =>
      expect(screen.getByTestId("provider-usage-screen")).toBeTruthy(),
    );
    // The model, not the sheet, kept the window: the reopen reads 7 again and
    // the chip comes back selected.
    await waitFor(() =>
      expect(
        usageReads(calls).filter((call) => call.url.endsWith("?days=7")),
      ).toHaveLength(2),
    );
    expect(
      screen.getByTestId("usage-window:7").props.accessibilityState?.selected,
    ).toBe(true);
    // Session memory only: the choice writes no new storage key.
    expect(mockSetItem).not.toHaveBeenCalled();
  });

  it("KIN-MOBILE-001 R6: a conversation with no stored session draws no usage entry and reads no providers", async () => {
    const { fetchImpl, calls } = routedFetch(usageRouter());
    const screen = await renderConversation(fetchImpl, noSession);

    await waitFor(() =>
      expect(screen.getByText(t("pairing.expired"))).toBeTruthy(),
    );
    expect(screen.queryByTestId("conversation:usage")).toBeNull();
    expect(screen.queryByTestId("provider-usage-screen")).toBeNull();
    expect(
      calls.filter((call) => call.url === `${ORIGIN}/api/providers`),
    ).toHaveLength(0);
  });

  it("KIN-MOBILE-001 R6: closing the sheet abandons an in-flight read instead of repainting a closed sheet", async () => {
    let releaseProviders!: () => void;
    const held = new Promise<Reply>((resolve) => {
      releaseProviders = () =>
        resolve({ body: { active_id: PROVIDER.id, providers: [PROVIDER] } });
    });
    const { fetchImpl, calls } = routedFetch((url) => {
      const thread = threadReply(url);
      if (thread) return thread;
      const pending = pendingReply(url);
      if (pending) return pending;
      if (url === `${ORIGIN}/api/providers`) return held;
      if (url.startsWith(`${ORIGIN}/api/usage/summary`)) {
        return { body: [usageRow()] };
      }
      throw new Error(`unexpected request: ${url}`);
    });

    const screen = await renderConversation(fetchImpl);
    await settled(screen);

    await fireEvent.press(screen.getByTestId("conversation:usage"));
    await waitFor(() =>
      expect(
        calls.find((call) => call.url === `${ORIGIN}/api/providers`),
      ).toBeDefined(),
    );
    // The transport's own signal, handed to the platform fetch.
    const providersSignal = calls.find(
      (call) => call.url === `${ORIGIN}/api/providers`,
    )?.init.signal;
    expect(providersSignal?.aborted).toBe(false);

    await fireEvent.press(screen.getByTestId("usage-close"));
    await waitFor(() =>
      expect(screen.queryByTestId("provider-usage-screen")).toBeNull(),
    );
    // The container told the model the sheet is gone: the read is aborted.
    expect(providersSignal?.aborted).toBe(true);

    // The answer still arrives; it paints nothing on the closed sheet.
    await act(async () => {
      releaseProviders();
      await Promise.resolve();
      await Promise.resolve();
    });
    expect(screen.queryByTestId("provider-usage-screen")).toBeNull();
    expect(screen.queryByText("Primary fixture")).toBeNull();
    expect(screen.getByText("all green")).toBeTruthy();
    expect(threadReads(calls)).toHaveLength(1);
  });

  it("KIN-MOBILE-001 R6: leaving the conversation abandons an in-flight usage read", async () => {
    let releaseProviders!: () => void;
    const held = new Promise<Reply>((resolve) => {
      releaseProviders = () =>
        resolve({ body: { active_id: PROVIDER.id, providers: [PROVIDER] } });
    });
    const { fetchImpl, calls } = routedFetch((url) => {
      const thread = threadReply(url);
      if (thread) return thread;
      const pending = pendingReply(url);
      if (pending) return pending;
      if (url === `${ORIGIN}/api/providers`) return held;
      if (url.startsWith(`${ORIGIN}/api/usage/summary`)) {
        return { body: [usageRow()] };
      }
      throw new Error(`unexpected request: ${url}`);
    });
    const screen = await renderConversation(fetchImpl);
    await settled(screen);

    await fireEvent.press(screen.getByTestId("conversation:usage"));
    await waitFor(() =>
      expect(
        calls.find((call) => call.url === `${ORIGIN}/api/providers`),
      ).toBeDefined(),
    );
    const signal = calls.find(
      (call) => call.url === `${ORIGIN}/api/providers`,
    )?.init.signal;
    expect(signal?.aborted).toBe(false);

    // Leaving the conversation disposes the model (AGENTS.md §11): the held
    // answer is aborted, and its resolution reaches no publisher.
    await screen.unmount();
    expect(signal?.aborted).toBe(true);
    await act(async () => {
      releaseProviders();
      await Promise.resolve();
      await Promise.resolve();
    });
  });

  it("KIN-MOBILE-001 R6: the empty device says so inside the sheet", async () => {
    const { fetchImpl } = routedFetch(usageRouter([], []));
    const screen = await renderConversation(fetchImpl);
    await settled(screen);

    await fireEvent.press(screen.getByTestId("conversation:usage"));
    await waitFor(() =>
      expect(screen.getByTestId("provider-usage-screen")).toBeTruthy(),
    );

    await waitFor(() =>
      expect(screen.getByText(t("agents.emptyUsageDevice"))).toBeTruthy(),
    );
    expect(screen.getByText(t("agents.emptyUsageHint"))).toBeTruthy();
    // Four zero tiles would be a lie: the sheet passes the empty branch
    // straight through (`providersModel.ts:252-258`).
    expect(screen.queryAllByTestId(/^tile:/)).toHaveLength(0);
  });
});
