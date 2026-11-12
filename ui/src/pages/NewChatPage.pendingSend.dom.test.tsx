// @vitest-environment jsdom
import { beforeEach, describe, expect, it, vi } from "vitest";
import { act, render, screen } from "@testing-library/react";
import { MemoryRouter, Route, Routes } from "react-router-dom";
import { setLocale } from "../i18n";
import NewChatPage from "./NewChatPage";

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
    createTask: api.createTask,
    recentCwds: pending,
    getRoutingOptions: pending,
    findProjectByRoot: pending,
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
    fallbackUserPrompt,
  }: {
    loading?: boolean;
    fallbackUserPrompt?: string;
  }) => (
    <div data-testid="chat">
      <span data-testid="loading">{String(Boolean(loading))}</span>
      <span data-testid="pending-user">{fallbackUserPrompt ?? ""}</span>
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

beforeEach(() => {
  setLocale("en");
  localStorage.clear();
  localStorage.setItem("kin_draft_cwd", "/work");
  api.createTask.mockClear();
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
      api.resolveCreate({
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
      });
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
