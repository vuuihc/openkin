// @vitest-environment jsdom
import { useSyncExternalStore, type ReactNode } from "react";
import { beforeEach, describe, expect, it, vi } from "vitest";
import { act, render, screen } from "@testing-library/react";
import { MemoryRouter } from "react-router-dom";
import { setLocale } from "../i18n";
import TaskDetailPage from "./TaskDetailPage";

/**
 * The composer clears itself the moment the person sends. What must not happen
 * is the message vanishing from the screen until the daemon answers: the local
 * copy is drawn immediately, the waiting row follows it, and the copy goes away
 * only when the transcript contains the message the daemon wrote for it.
 */

const store = vi.hoisted(() => {
  const listeners = new Set<() => void>();
  const state = {
    version: 0,
    events: [] as unknown[],
  };
  return {
    state,
    subscribe(listener: () => void) {
      listeners.add(listener);
      return () => listeners.delete(listener);
    },
    version: () => state.version,
    setEvents(events: unknown[]) {
      state.events = events;
      state.version += 1;
      for (const listener of listeners) listener();
    },
  };
});

vi.mock("../api/useLiveResources", () => ({
  useTaskResource: (id: string) => {
    useSyncExternalStore(store.subscribe, store.version, store.version);
    return {
      loaded: true,
      error: null,
      data: {
        task: {
          id,
          title: "Conversation",
          status: "succeeded",
          agent: "kin",
          cwd: "/work",
          prompt: "first",
          tokens_in: 0,
          tokens_out: 0,
          event_epoch: 0,
          created_at: 1,
        },
        events: store.state.events,
        deleted: false,
      },
    };
  },
  usePendingResources: () => ({ data: { approvals: [], questions: [] } }),
}));

const api = vi.hoisted(() => {
  let resolveSend: ((task: unknown) => void) | null = null;
  let rejectSend: ((error: unknown) => void) | null = null;
  return {
    followUpPrompt: vi.fn(
      () =>
        new Promise((resolve, reject) => {
          resolveSend = resolve;
          rejectSend = reject;
        }),
    ),
    resolveSend(task: unknown) {
      resolveSend?.(task);
    },
    rejectSend(error: unknown) {
      rejectSend?.(error);
    },
  };
});

vi.mock("../api/client", async (importOriginal) => {
  const actual = await importOriginal<typeof import("../api/client")>();
  const pending = () => new Promise<never>(() => {});
  return {
    ...actual,
    isAuthenticated: () => true,
    listAgents: pending,
    getTaskUsage: pending,
    getTaskLimitWait: pending,
    listQueuedPrompts: pending,
    listWorkerSteps: pending,
    followUpPrompt: api.followUpPrompt,
  };
});

vi.mock("../hooks/useMachines", () => ({
  useMachines: () => ({ machines: [], loading: false, failed: false }),
}));
vi.mock("../components/mobile/MobileHeader", () => ({
  default: ({ title }: { title?: string }) => <div>{title}</div>,
  MobileHeaderButton: ({ children }: { children?: ReactNode }) => (
    <button type="button">{children}</button>
  ),
}));
vi.mock("../components/chat/Composer", () => ({
  default: ({
    onSubmit,
    disabled,
  }: {
    onSubmit: (text: string) => Promise<void> | void;
    disabled?: boolean;
  }) => (
    <button
      type="button"
      data-testid="send"
      disabled={disabled}
      onClick={() => {
        void Promise.resolve(onSubmit("hello")).catch(() => {});
      }}
    >
      send
    </button>
  ),
}));
vi.mock("../components/chat/ChatStream", () => ({
  default: ({
    loading,
    pendingUserMessages,
  }: {
    loading?: boolean;
    pendingUserMessages?: readonly { key: string; text: string }[];
  }) => (
    <div data-testid="chat">
      <span data-testid="loading">{String(Boolean(loading))}</span>
      {(pendingUserMessages ?? []).map((message) => (
        <span key={message.key} data-testid="pending-user">
          {message.text}
        </span>
      ))}
    </div>
  ),
}));

class ResizeObserverStub {
  observe() {}
  unobserve() {}
  disconnect() {}
}

function open() {
  return render(
    <MemoryRouter initialEntries={["/tasks/task-1"]}>
      <TaskDetailPage taskId="task-1" />
    </MemoryRouter>,
  );
}

beforeEach(() => {
  vi.stubGlobal("ResizeObserver", ResizeObserverStub);
  setLocale("en");
  localStorage.clear();
  store.state.version = 0;
  store.state.events = [];
  api.followUpPrompt.mockClear();
});

describe("sending a follow-up", () => {
  it("shows the message and the waiting row before the request answers", async () => {
    open();
    await act(async () => {
      screen.getByTestId("send").click();
    });
    expect(screen.getByTestId("pending-user").textContent).toBe("hello");
    expect(screen.getByTestId("loading").textContent).toBe("true");
    // The request is still in flight — the feedback did not wait for it.
    expect(api.followUpPrompt).toHaveBeenCalledTimes(1);
  });

  it("hands the bubble over to the daemon's own message when it lands", async () => {
    open();
    await act(async () => {
      screen.getByTestId("send").click();
    });
    await act(async () => {
      api.resolveSend({ id: "task-1", status: "running" });
    });
    // The POST answered, but the transcript has not echoed it yet: the local
    // copy is still the only thing on screen, so it stays.
    expect(screen.getByTestId("pending-user").textContent).toBe("hello");

    act(() => {
      store.setEvents([
        {
          task_id: "task-1",
          event_epoch: 0,
          seq: 1,
          ts: 1,
          type: "message",
          payload: { role: "user", speaker: "user", content: [{ type: "text", text: "hello" }] },
        },
      ]);
    });
    expect(screen.queryByTestId("pending-user")).toBeNull();
  });

  it("takes the local copy back when the send is refused", async () => {
    open();
    await act(async () => {
      screen.getByTestId("send").click();
    });
    expect(screen.getByTestId("pending-user").textContent).toBe("hello");

    await act(async () => {
      api.rejectSend(new Error("refused"));
    });
    expect(screen.queryByTestId("pending-user")).toBeNull();
  });
});
