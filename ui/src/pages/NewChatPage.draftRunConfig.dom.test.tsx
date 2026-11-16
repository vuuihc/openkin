// @vitest-environment jsdom
import type { ReactNode } from "react";
import { beforeEach, describe, expect, it, vi } from "vitest";
import { act, render, screen, within } from "@testing-library/react";
import userEvent from "@testing-library/user-event";
import { MemoryRouter, Route, Routes } from "react-router-dom";
import { setLocale } from "../i18n";
import NewChatPage from "./NewChatPage";

/**
 * D5: the draft keeps its run face.
 *
 * The draft already stored its cwd, machine, prompt and attachments, but the
 * model and agent were `useState("")` in the page. Closing the draft and
 * coming back therefore sent the next run to the agent/provider default even
 * though the reader had chosen otherwise. These tests drive the real page and
 * the real run-settings control: choose, leave, return, send.
 */

const api = vi.hoisted(() => ({
  createTask: vi.fn(async (_body: Record<string, unknown>) => ({
    id: "task-1",
    title: "hello",
    status: "queued",
    agent: "kin",
    cwd: "/work",
    prompt: "hello",
    tokens_in: 0,
    tokens_out: 0,
    event_epoch: 0,
    created_at: 1,
  })),
}));

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
        models: [
          { id: "model-a", label: "Model A" },
          { id: "model-b", label: "Model B" },
        ],
        model_list_source: "configured",
        model_list_status: "available",
      },
      {
        id: "claude-code",
        name: "Claude Code",
        installed: true,
        available: true,
        default: false,
        models: [{ id: "model-c", label: "Model C" }],
        model_list_source: "configured",
        model_list_status: "available",
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
    footer,
  }: {
    onSubmit: (text: string) => Promise<void> | void;
    disabled?: boolean;
    footer?: ReactNode;
  }) => (
    <div>
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
      {footer}
    </div>
  ),
}));
vi.mock("../components/chat/ChatStream", () => ({
  default: () => <div data-testid="chat" />,
}));

function viewport() {
  vi.stubGlobal("matchMedia", (query: string) => ({
    matches: false,
    media: query,
    onchange: null,
    addEventListener: vi.fn(),
    removeEventListener: vi.fn(),
    addListener: vi.fn(),
    removeListener: vi.fn(),
    dispatchEvent: vi.fn(),
  }));
}

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

async function chooseModel(label: string) {
  const user = userEvent.setup();
  await user.click(screen.getByRole("button", { name: /^Run settings/ }));
  const sheet = await screen.findByRole("dialog", { name: "Run settings" });
  await user.click(within(sheet).getByRole("button", { name: /^Model:/ }));
  await user.click(await screen.findByRole("menuitemradio", { name: label }));
}

beforeEach(() => {
  setLocale("en");
  localStorage.clear();
  localStorage.setItem("kin_draft_cwd", "/work");
  api.createTask.mockClear();
  viewport();
});

describe("the draft's run face", () => {
  it("keeps the chosen model across leave and return, then sends it", async () => {
    const first = open();
    await screen.findByRole("button", { name: /^Run settings/ });
    await chooseModel("Model B");
    first.unmount();

    open();
    const face = await screen.findByRole("button", { name: /^Run settings/ });
    expect(face.textContent).toContain("Model B");

    await act(async () => {
      screen.getByTestId("send").click();
    });
    expect(api.createTask.mock.calls[0]?.[0]).toMatchObject({
      agent: "kin",
      model: "model-b",
      cwd: "/work",
    });
  });

  it("keeps the chosen agent across leave and return, then sends it", async () => {
    const user = userEvent.setup();
    const first = open();
    await screen.findByRole("button", { name: /^Run settings/ });
    await user.click(screen.getByRole("button", { name: /^Run settings/ }));
    const sheet = await screen.findByRole("dialog", { name: "Run settings" });
    await user.click(within(sheet).getByRole("button", { name: /^Agent:/ }));
    await user.click(await screen.findByRole("menuitemradio", { name: /Claude Code/ }));
    first.unmount();

    open();
    const face = await screen.findByRole("button", { name: /^Run settings/ });
    expect(face.textContent).toContain("Claude Code");

    await act(async () => {
      screen.getByTestId("send").click();
    });
    expect(api.createTask.mock.calls[0]?.[0]).toMatchObject({ agent: "claude-code" });
    // The model belonged to the agent it was chosen for; the switch cleared it.
    expect(api.createTask.mock.calls[0]?.[0]).not.toHaveProperty("model");
  });
});
