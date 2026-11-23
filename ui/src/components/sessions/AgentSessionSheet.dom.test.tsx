// @vitest-environment jsdom
import { useState } from "react";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { render, screen, waitFor } from "@testing-library/react";
import userEvent from "@testing-library/user-event";
import { MemoryRouter, Route, Routes } from "react-router-dom";
import type {
  AgentSession,
  AgentSessionBinding,
  AgentSessionHistoryItem,
  AgentSessionHistoryPage,
  Task,
} from "../../api/client";
import { setLocale } from "../../i18n";

/**
 * The imported agent session's sheet.
 *
 * A row in the imported index used to leave the list for the full page; the
 * sheet is the list's own surface, so opening one keeps the reader where they
 * were. It reads the same newest-three-turns window the page opens on, and its
 * one composer does exactly what the page's does: attach the source session to
 * a new Kin task and land on it.
 */

const session: AgentSession = {
  id: "s1",
  agent_id: "claude-code",
  external_ref: "ref-1",
  title: "a long session",
  cwd: "/work/project",
  status: "idle",
  first_seen_at: 1,
  last_seen_at: 2,
  updated_at: 2,
  linked: false,
  capabilities: ["session_attach"],
};

vi.mock("../../api/client", async (importOriginal) => {
  const actual = await importOriginal<typeof import("../../api/client")>();
  return {
    ...actual,
    isAuthenticated: () => true,
    getAgentSession: vi.fn(async () => session),
    getAgentSessionHistory: vi.fn(),
    attachAgentSession: vi.fn(),
  };
});

vi.mock("../../hooks/useAgentRoles", () => ({
  useAgentRoles: vi.fn(() => []),
}));

import { attachAgentSession, getAgentSession, getAgentSessionHistory } from "../../api/client";
import { useAgentRoles } from "../../hooks/useAgentRoles";
import AgentSessionSheet from "./AgentSessionSheet";

type HistoryCall = { tail?: boolean; before?: string; limit?: number };

function item(
  messageID: string,
  role: AgentSessionHistoryItem["role"],
  text: string,
): AgentSessionHistoryItem {
  return {
    agent_id: "claude-code",
    external_ref: "ref-1",
    message_id: messageID,
    kind: "message",
    role,
    text,
    occurred_at: 1,
    source_rev: "rev-1",
  };
}

/**
 * One transcript served the way the history route serves it: `tail` is the
 * newest page, `before` walks backwards, `prev_cursor` is where the page
 * before it begins. Copied from the page's own budget test so the sheet is
 * held to the same page size the real route answers with.
 */
function pagedHistory(all: AgentSessionHistoryItem[]) {
  const calls: HistoryCall[] = [];
  const impl = vi.fn(
    async (_id: string, params?: HistoryCall): Promise<AgentSessionHistoryPage> => {
      calls.push(params ?? {});
      const limit = params?.limit ?? 30;
      const end = params?.tail ? all.length : Number(params?.before ?? all.length);
      const start = Math.max(0, end - limit);
      return {
        items: all.slice(start, end),
        prev_cursor: start > 0 ? String(start) : "",
      };
    },
  );
  return { impl, calls };
}

function fiftyTurns(): AgentSessionHistoryItem[] {
  const all: AgentSessionHistoryItem[] = [];
  for (let turn = 1; turn <= 50; turn += 1) {
    all.push(item(`u${turn}`, "user", `question ${turn}`));
    all.push(item(`a${turn}`, "assistant", `answer ${turn}`));
  }
  return all;
}

function Host({ offline = false }: { offline?: boolean }) {
  const [open, setOpen] = useState(true);
  return (
    <>
      {/* Stands in for the list row: the sheet's opener, and where focus goes
          back to. */}
      <button type="button" onClick={() => setOpen(true)}>
        open the session
      </button>
      <AgentSessionSheet
        open={open}
        session={session}
        offline={offline}
        onClose={() => setOpen(false)}
      />
    </>
  );
}

function renderSheet(options: { offline?: boolean } = {}) {
  return render(
    <MemoryRouter initialEntries={["/sessions"]}>
      <Routes>
        <Route path="/sessions" element={<Host offline={options.offline} />} />
        <Route path="/tasks/:id" element={<div>task screen</div>} />
      </Routes>
    </MemoryRouter>,
  );
}

beforeEach(() => {
  setLocale("en");
  window.history.replaceState({}, "", "/sessions");
  vi.mocked(getAgentSession).mockReset();
  vi.mocked(getAgentSession).mockResolvedValue(session);
  vi.mocked(getAgentSessionHistory).mockReset();
  vi.mocked(attachAgentSession).mockReset();
});

afterEach(() => {
  vi.clearAllMocks();
  vi.unstubAllGlobals();
});

/** jsdom has no matchMedia; the pull-down grabber follows the pointer. */
function pointer(kind: "fine" | "coarse") {
  vi.stubGlobal("matchMedia", (query: string) => ({
    matches: query === "(pointer: coarse)" ? kind === "coarse" : false,
    media: query,
    onchange: null,
    addEventListener: vi.fn(),
    removeEventListener: vi.fn(),
    addListener: vi.fn(),
    removeListener: vi.fn(),
    dispatchEvent: vi.fn(),
  }));
}

describe("AgentSessionSheet", () => {
  it("the sheet names the agent and shows the session's recent turns", async () => {
    const all = fiftyTurns();
    const { impl, calls } = pagedHistory(all);
    vi.mocked(getAgentSessionHistory).mockImplementation(impl);

    renderSheet();

    // The title is the session's, and the agent is named beside it.
    expect(await screen.findByRole("dialog", { name: /a long session/ })).toBeTruthy();
    expect(screen.getAllByText("Claude Code").length).toBeGreaterThan(0);
    // The newest three turns, and nothing from the fourth: the sheet shows
    // fewer turns than the page only by stopping, never by reading past its
    // budget.
    await screen.findByText(/question 50/);
    expect(screen.getByText(/question 48/)).toBeTruthy();
    expect(screen.getByText(/answer 50/)).toBeTruthy();
    expect(screen.queryByText(/question 47/)).toBeNull();
    expect(calls).toHaveLength(1);
    // One composer, exactly: the transcript is not a second input.
    expect(screen.getAllByRole("textbox")).toHaveLength(1);
  });

  it("the sheet's one composer attaches the session and opens the task", async () => {
    vi.mocked(getAgentSessionHistory).mockResolvedValue({
      items: [item("u1", "user", "question 1"), item("a1", "assistant", "answer 1")],
      prev_cursor: "",
    });
    vi.mocked(attachAgentSession).mockResolvedValue({
      task: { id: "task-42", title: "carried on" } as Task,
      binding: { id: "b1" } as AgentSessionBinding,
    });

    renderSheet();

    const box = await screen.findByRole("textbox");
    await userEvent.type(box, "carry on");
    await userEvent.click(screen.getByRole("button", { name: "Send" }));

    await waitFor(() =>
      expect(attachAgentSession).toHaveBeenCalledWith("s1", { prompt: "carry on" }),
    );
    // The sheet gives its history entry back before the task is pushed, so
    // Back from the task reaches the list rather than the closed sheet.
    await screen.findByText("task screen");
  });

  it("an empty source session says there is nothing readable", async () => {
    vi.mocked(getAgentSessionHistory).mockResolvedValue({ items: [], prev_cursor: "" });

    renderSheet();

    await screen.findByText("No readable messages were found in this source session.");
  });

  it("a failed read keeps the last result and offers a retry", async () => {
    const all = fiftyTurns();
    const { impl } = pagedHistory(all);
    vi.mocked(getAgentSessionHistory).mockImplementation(impl);

    renderSheet();
    await screen.findByText(/question 50/);

    // Reopening after the machine went away: the refresh fails, and the
    // messages the reader already had stay on screen with the retry beside
    // them rather than being replaced by a blank error.
    vi.mocked(getAgentSessionHistory).mockRejectedValueOnce(new Error("read failed"));
    await userEvent.keyboard("{Escape}");
    await waitFor(() => expect(screen.queryByRole("dialog")).toBeNull());
    await userEvent.click(screen.getByRole("button", { name: "open the session" }));
    await screen.findByText("read failed");
    expect(screen.getByText(/question 48/)).toBeTruthy();
    expect(screen.getByRole("button", { name: "Try again" })).toBeTruthy();
  });

  it("disconnected blocks the send but keeps the draft", async () => {
    vi.mocked(getAgentSessionHistory).mockResolvedValue({
      items: [item("u1", "user", "question 1"), item("a1", "assistant", "answer 1")],
      prev_cursor: "",
    });

    renderSheet({ offline: true });

    const box = await screen.findByRole("textbox");
    await userEvent.type(box, "a draft for later");
    expect((box as HTMLTextAreaElement).value).toBe("a draft for later");
    expect((screen.getByRole("button", { name: "Send" }) as HTMLButtonElement).disabled).toBe(true);
    expect(screen.getByText(/You are offline/)).toBeTruthy();
  });

  it("names the agent once when the transcript opens on its turn", async () => {
    // The sheet's own header already says who the session belongs to. When the
    // oldest visible turn is that agent's, ChatStream's own speaker header
    // would print the same avatar and name directly below it. One final
    // assistant turn is the smallest transcript that opens on the agent.
    vi.mocked(getAgentSessionHistory).mockResolvedValue({
      items: [item("a1", "assistant", "answer 1")],
      prev_cursor: "",
    });

    renderSheet();

    await screen.findByText("answer 1");
    expect(screen.getAllByText("Claude Code")).toHaveLength(1);
  });

  it("reads no agent roles while the sheet is closed", async () => {
    // The sheet stays mounted between opens so a reopen keeps the turns it
    // already read. The role read belongs to the open surface: a closed sheet
    // must not make the shell's startup call settings.
    vi.mocked(getAgentSessionHistory).mockResolvedValue({ items: [], prev_cursor: "" });
    const roles = vi.mocked(useAgentRoles);
    roles.mockClear();
    const { rerender } = render(
      <MemoryRouter initialEntries={["/sessions"]}>
        <AgentSessionSheet open={false} session={session} onClose={() => {}} />
      </MemoryRouter>,
    );
    expect(roles).not.toHaveBeenCalled();

    rerender(
      <MemoryRouter initialEntries={["/sessions"]}>
        <AgentSessionSheet open session={session} onClose={() => {}} />
      </MemoryRouter>,
    );
    expect(roles).toHaveBeenCalled();
  });

  it("no pull-down grabber for a mouse", async () => {
    pointer("fine");
    vi.mocked(getAgentSessionHistory).mockResolvedValue({ items: [], prev_cursor: "" });

    renderSheet();

    await screen.findByRole("dialog", { name: /a long session/ });
    expect(document.querySelector("[data-sheet-grip]")).toBeNull();
  });

  it("keeps the pull-down grabber for a finger", async () => {
    pointer("coarse");
    vi.mocked(getAgentSessionHistory).mockResolvedValue({ items: [], prev_cursor: "" });

    renderSheet();

    await screen.findByRole("dialog", { name: /a long session/ });
    expect(document.querySelector("[data-sheet-grip]")).not.toBeNull();
  });
});
