// @vitest-environment jsdom
import { useSyncExternalStore, type ReactNode } from "react";
import { beforeEach, describe, expect, it, vi } from "vitest";
import { act, render, screen } from "@testing-library/react";
import { MemoryRouter } from "react-router-dom";
import { setLocale } from "../i18n";
import { forgetPendingSend, handOffPendingSend } from "../lib/pendingSend";
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
    /** The detail's `loaded`: the tests that hand a send over start before it. */
    loaded: true,
    task: null as unknown,
    error: null as unknown,
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
    setDetail(next: { loaded?: boolean; task?: unknown; error?: unknown }) {
      if (next.loaded !== undefined) state.loaded = next.loaded;
      if ("task" in next) state.task = next.task;
      if ("error" in next) state.error = next.error;
      state.version += 1;
      for (const listener of listeners) listener();
    },
  };
});

vi.mock("../api/useLiveResources", () => ({
  useTaskResource: (id: string) => {
    useSyncExternalStore(store.subscribe, store.version, store.version);
    return {
      loaded: store.state.loaded,
      error: store.state.error,
      data: {
        task: store.state.task ?? {
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
    focusSignal,
  }: {
    onSubmit: (text: string) => Promise<void> | void;
    disabled?: boolean;
    focusSignal?: number;
  }) => (
    <button
      type="button"
      data-testid="send"
      data-focus-signal={String(focusSignal ?? 0)}
      disabled={disabled}
      onClick={() => {
        void Promise.resolve(onSubmit("hello")).catch(() => {});
      }}
    >
      send
    </button>
  ),
}));
type MockImage = { name: string; src: string };

vi.mock("../components/chat/ChatStream", () => ({
  default: ({
    loading,
    events,
    pendingUserMessages,
    fallbackUserPromptImages,
  }: {
    loading?: boolean;
    events?: readonly {
      seq: number;
      type: string;
      payload?: { speaker?: string; content?: readonly { text?: string }[] };
    }[];
    pendingUserMessages?: readonly { key: string; text: string; images?: readonly MockImage[] }[];
    fallbackUserPromptImages?: readonly MockImage[];
  }) => (
    <div data-testid="chat">
      <span data-testid="loading">{String(Boolean(loading))}</span>
      {(events ?? [])
        .filter((event) => event.type === "message" && event.payload?.speaker === "user")
        .map((event) => (
          <span key={event.seq} data-testid="server-user">
            {(event.payload?.content ?? []).map((part) => part.text ?? "").join("")}
          </span>
        ))}
      {(pendingUserMessages ?? []).map((message) => (
        <span key={message.key} data-testid="pending-user">
          {message.text}
          {(message.images ?? []).map((image) => (
            <span key={image.src} data-testid="pending-image" data-src={image.src} />
          ))}
        </span>
      ))}
      {(fallbackUserPromptImages ?? []).map((image) => (
        <span key={image.src} data-testid="fallback-image" data-src={image.src} />
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
  store.state.loaded = true;
  store.state.task = null;
  store.state.error = null;
  forgetPendingSend("task-1");
  forgetPendingSend("task-2");
  api.followUpPrompt.mockClear();
});

describe("a send handed over from the new-conversation route", () => {
  it("keeps the bubble across a missing detail and settles it once, on the server copy", () => {
    handOffPendingSend("task-1", { id: "handoff-1", text: "hello", images: [], startSeq: 0 });
    store.setDetail({ loaded: false });
    open();

    // The GET has not answered; the bubble is the only copy of the message
    // and it is already on screen, exactly once.
    expect(screen.getAllByTestId("pending-user")).toHaveLength(1);
    expect(screen.getByTestId("pending-user").textContent).toBe("hello");

    // Somebody else's event is not this send's copy.
    act(() => {
      store.setEvents([
        {
          task_id: "task-1",
          event_epoch: 0,
          seq: 1,
          ts: 1,
          type: "message",
          payload: { role: "assistant", speaker: "kin", content: [{ type: "text", text: "hi" }] },
        },
      ]);
    });
    expect(screen.getByTestId("pending-user").textContent).toBe("hello");

    // The daemon's own message lands: the local copy goes and there is one
    // user bubble, not two.
    act(() => {
      store.setEvents([
        {
          task_id: "task-1",
          event_epoch: 0,
          seq: 1,
          ts: 1,
          type: "message",
          payload: { speaker: "kin", content: [{ type: "text", text: "hi" }] },
        },
        {
          task_id: "task-1",
          event_epoch: 0,
          seq: 2,
          ts: 2,
          type: "message",
          payload: { role: "user", speaker: "user", content: [{ type: "text", text: "hello" }] },
        },
      ]);
    });
    expect(screen.queryByTestId("pending-user")).toBeNull();
    expect(screen.getAllByTestId("server-user")).toHaveLength(1);
    expect(screen.getByTestId("server-user").textContent).toBe("hello");
  });

  it("never draws a handoff meant for another conversation", () => {
    handOffPendingSend("task-2", { id: "handoff-2", text: "elsewhere", images: [], startSeq: 0 });
    store.setDetail({ loaded: false });
    open();
    expect(screen.queryByTestId("pending-user")).toBeNull();
  });

  it("hands a conversation entered from Start the caret and the raised composer", () => {
    // The draft composer was raised while the person typed, and step 5 puts
    // the caret back in the conversation's composer. The signal is what gives
    // Composer that arrangement from its first frame, before the detail loads.
    handOffPendingSend("task-1", { id: "handoff-1", text: "hello", images: [], startSeq: 0 });
    store.setDetail({ loaded: false });
    open();
    expect(screen.getByTestId("send").getAttribute("data-focus-signal")).toBe("1");
  });

  it("leaves a conversation opened from the list alone", () => {
    open();
    expect(screen.getByTestId("send").getAttribute("data-focus-signal")).toBe("0");
  });

  it("does not replay the handoff on a later visit to the same conversation", () => {
    handOffPendingSend("task-1", { id: "handoff-1", text: "hello", images: [], startSeq: 0 });
    store.setDetail({ loaded: false });
    const first = open();
    expect(screen.getAllByTestId("pending-user")).toHaveLength(1);

    // Back, a tab, a reload: the record was adopted by the first visit and
    // must not draw the old message again.
    first.unmount();
    open();
    expect(screen.queryByTestId("pending-user")).toBeNull();
  });

  it("keeps the handed-off message when the detail request fails", () => {
    handOffPendingSend("task-1", { id: "handoff-1", text: "hello", images: [], startSeq: 0 });
    store.setDetail({ loaded: true, error: new Error("detail failed") });
    open();

    expect(screen.getByTestId("pending-user").textContent).toBe("hello");
    expect(screen.getByRole("alert").textContent).toContain("detail failed");
    // The composer is still there; the failure is about the transcript, not
    // the conversation.
    expect(screen.getByTestId("send")).toBeTruthy();
  });
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

describe("images in a sent prompt", () => {
  it("hands the pending send's images to the stream", () => {
    handOffPendingSend("task-1", {
      id: "handoff-img",
      text: "look\n\nAttached image: shot.png",
      images: [{ name: "shot.png", src: "/api/uploads/abc.png" }],
      startSeq: 0,
    });
    store.setDetail({ loaded: false });
    open();

    expect(screen.getByTestId("pending-image").getAttribute("data-src")).toBe(
      "/api/uploads/abc.png",
    );
  });

  it("derives the cold page's fallback images from the task prompt", () => {
    store.setDetail({
      task: {
        id: "task-1",
        title: "Conversation",
        status: "succeeded",
        agent: "kin",
        cwd: "/work",
        prompt: "look\n\nAttached image:\n- shot.png: /Users/me/.kin/uploads/abc.png",
        tokens_in: 0,
        tokens_out: 0,
        event_epoch: 0,
        created_at: 1,
      },
    });
    open();

    expect(screen.getByTestId("fallback-image").getAttribute("data-src")).toBe(
      "/api/uploads/abc.png",
    );
  });
});
