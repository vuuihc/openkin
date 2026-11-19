// @vitest-environment jsdom
import { beforeEach, describe, expect, it, vi } from "vitest";
import type { ReactNode } from "react";
import { act, render, screen } from "@testing-library/react";
import { MemoryRouter, Route, Routes } from "react-router-dom";
import { setLocale } from "../i18n";
import { forgetPendingSend } from "../lib/pendingSend";
import NewChatPage from "./NewChatPage";
import TaskDetailPage from "./TaskDetailPage";

/**
 * A new conversation has no task id until the create request answers. The draft
 * page must not sit still for that round trip: the moment the person sends, the
 * body becomes the conversation they are about to have — their message, then
 * the host's waiting row — while the create request is still in flight.
 */

const api = vi.hoisted(() => {
  let resolveCreate: ((task: unknown) => void) | null = null;
  let rejectCreate: ((error: unknown) => void) | null = null;
  return {
    createTask: vi.fn(
      () =>
        new Promise((resolve, reject) => {
          resolveCreate = resolve;
          rejectCreate = reject;
        }),
    ),
    // The conversation route asks for the detail the moment it mounts. It
    // never answers here: the whole point is that the handoff draws before it.
    getTask: vi.fn(() => new Promise<never>(() => {})),
    resolveCreate(task: unknown) {
      resolveCreate?.(task);
    },
    rejectCreate(error: unknown) {
      rejectCreate?.(error);
    },
  };
});

vi.mock("../api/client", async (importOriginal) => {
  const actual = await importOriginal<typeof import("../api/client")>();
  const pending = () => new Promise<never>(() => {});
  return {
    ...actual,
    isAuthenticated: () => true,
    createTask: api.createTask,
    getTask: api.getTask,
    recentCwds: pending,
    getRoutingOptions: pending,
    findProjectByRoot: pending,
    listApprovals: pending,
    listUserQuestions: pending,
    listAgents: pending,
    getTaskUsage: pending,
    getTaskLimitWait: pending,
    listQueuedPrompts: pending,
    listWorkerSteps: pending,
  };
});

vi.mock("../hooks/useMachines", () => ({
  useMachines: () => ({
    machines: [
      { id: "self", name: "This Mac", isSelf: true, online: true, roots: ["/work"], agents: [] },
    ],
    agents: [
      {
        id: "kin",
        name: "Kin",
        installed: true,
        available: true,
        default: true,
        model_list_source: "none",
        model_list_status: "default_only",
      },
    ],
    loading: false,
    failed: false,
    refresh: () => {},
  }),
}));
vi.mock("../hooks/useAgentRoles", () => ({ useAgentRoles: () => [] }));
vi.mock("../components/mobile/MobileHeader", () => ({
  default: ({ title }: { title?: string }) => <div data-testid="mobile-header">{title}</div>,
  MobileHeaderButton: ({ children, label }: { children?: ReactNode; label?: string }) => (
    <button type="button" aria-label={label}>
      {children}
    </button>
  ),
}));
/** What the mocked composer will submit next; most tests leave it at "hello". */
const composer = vi.hoisted(() => ({ text: "hello" }));

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
        void Promise.resolve(onSubmit(composer.text)).catch(() => {});
      }}
    >
      Start
    </button>
  ),
}));
type MockImage = { name: string; src: string };

vi.mock("../components/chat/ChatStream", () => ({
  default: ({
    loading,
    fallbackUserPrompt,
    fallbackUserPromptImages,
    pendingUserMessages,
  }: {
    loading?: boolean;
    fallbackUserPrompt?: string;
    fallbackUserPromptImages?: readonly MockImage[];
    pendingUserMessages?: readonly { key: string; text: string }[];
  }) => (
    <div data-testid="chat">
      <span data-testid="loading">{String(Boolean(loading))}</span>
      <span data-testid="pending-user">
        {fallbackUserPrompt ?? ""}
        {(fallbackUserPromptImages ?? []).map((image) => (
          <span key={image.src} data-testid="pending-image" data-src={image.src} />
        ))}
      </span>
      {(pendingUserMessages ?? []).map((message) => (
        <span key={message.key} data-testid="pending-handoff">
          {message.text}
        </span>
      ))}
    </div>
  ),
}));

function open() {
  return render(
    <MemoryRouter initialEntries={["/new"]}>
      <Routes>
        <Route path="/new" element={<NewChatPage />} />
        <Route path="/tasks/:id" element={<div>conversation page</div>} />
      </Routes>
    </MemoryRouter>,
  );
}

/** The real conversation route, so the handoff crosses the real boundary. */
function openWithConversation() {
  return render(
    <MemoryRouter initialEntries={["/new"]}>
      <Routes>
        <Route path="/new" element={<NewChatPage />} />
        <Route path="/tasks/:id" element={<TaskDetailPage />} />
      </Routes>
    </MemoryRouter>,
  );
}

const created = {
  id: "task-9",
  title: "hello",
  status: "queued",
  agent: "kin",
  cwd: "/work",
  prompt: "hello",
  tokens_in: 0,
  tokens_out: 0,
  event_epoch: 0,
  created_at: 1,
};

// The conversation route watches its scroller; jsdom has no ResizeObserver, and
// nothing here depends on it firing.
class ResizeObserverStub {
  observe() {}
  unobserve() {}
  disconnect() {}
}

beforeEach(() => {
  vi.stubGlobal("ResizeObserver", ResizeObserverStub);
  setLocale("en");
  localStorage.clear();
  localStorage.setItem("kin_draft_cwd", "/work");
  composer.text = "hello";
  forgetPendingSend("task-9");
  api.createTask.mockClear();
  api.getTask.mockClear();
});

describe("starting a conversation", () => {
  it("shows the message and the waiting row before the create request answers", async () => {
    open();
    await act(async () => {
      screen.getByTestId("send").click();
    });
    expect(screen.getByTestId("pending-user").textContent).toBe("hello");
    expect(screen.getByTestId("loading").textContent).toBe("true");
    expect(api.createTask).toHaveBeenCalledTimes(1);
  });

  it("hands over to the conversation route once the task exists", async () => {
    open();
    await act(async () => {
      screen.getByTestId("send").click();
    });
    await act(async () => {
      api.resolveCreate(created);
    });
    expect(screen.getByText("conversation page")).toBeTruthy();
  });

  it("keeps the pending bubble and waiting row across the create-route handoff", async () => {
    openWithConversation();
    await act(async () => {
      screen.getByTestId("send").click();
    });
    // Before the create answers: the draft route already draws the bubble and
    // the waiting row.
    expect(screen.getByTestId("pending-user").textContent).toBe("hello");
    expect(screen.getByTestId("loading").textContent).toBe("true");

    await act(async () => {
      api.resolveCreate(created);
    });

    // After the answer the real conversation route owns the screen. Its detail
    // request is still in flight, yet there is no page skeleton: the header,
    // the composer, the same bubble and a waiting row are all drawn from the
    // create snapshot.
    expect(screen.getByTestId("mobile-header").textContent).toContain("hello");
    expect(screen.getByTestId("send")).toBeTruthy();
    expect(screen.getByTestId("pending-handoff").textContent).toBe("hello");
    expect(screen.getByTestId("loading").textContent).toBe("true");
    // Not the whole-page skeleton: that branch is the one with a "Loading"
    // status where the header and composer should be.
    expect(screen.queryByRole("status", { name: "Loading" })).toBeNull();
  });

  it("keeps the composer mounted while the create request is in flight", async () => {
    open();
    await act(async () => {
      screen.getByTestId("send").click();
    });
    expect(api.createTask).toHaveBeenCalledTimes(1);
    // The draft's body becomes the conversation about to happen, and the
    // composer stays under it — not a skeleton, not an empty column.
    expect(screen.getByTestId("pending-user").textContent).toBe("hello");
    expect(screen.getByTestId("loading").textContent).toBe("true");
    expect(screen.getByTestId("send").textContent).toBe("Start");
    expect(screen.queryByRole("status", { name: "Loading" })).toBeNull();

    await act(async () => {
      api.resolveCreate(created);
    });
    expect(screen.getByText("conversation page")).toBeTruthy();
  });

  it("goes back to the draft when the create request is refused", async () => {
    open();
    await act(async () => {
      screen.getByTestId("send").click();
    });
    expect(screen.getByTestId("pending-user").textContent).toBe("hello");

    await act(async () => {
      api.rejectCreate(new Error("refused"));
    });
    expect(screen.queryByTestId("pending-user")).toBeNull();
    expect(screen.getByTestId("send")).toBeTruthy();
  });
});

describe("images in a draft send", () => {
  it("draws the images the composer sent, before the create answers", async () => {
    composer.text = "look\n\nAttached image:\n- shot.png: /Users/me/.kin/uploads/abc.png";
    open();
    await act(async () => {
      screen.getByTestId("send").click();
    });

    expect(screen.getByTestId("pending-user").textContent).toBe("look\n\nAttached image: shot.png");
    expect(screen.getByTestId("pending-image").getAttribute("data-src")).toBe(
      "/api/uploads/abc.png",
    );
    expect(screen.getByTestId("pending-user").textContent).not.toContain("/Users/");
  });
});
