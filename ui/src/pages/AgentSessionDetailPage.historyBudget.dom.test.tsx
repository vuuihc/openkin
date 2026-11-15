// @vitest-environment jsdom
import { afterEach, describe, expect, it, vi } from "vitest";
import { fireEvent, render, screen } from "@testing-library/react";
import { MemoryRouter, Route, Routes } from "react-router-dom";
import type { AgentSessionHistoryItem, AgentSessionHistoryPage } from "../api/client";

vi.mock("../api/client", async (importOriginal) => {
  const actual = await importOriginal<typeof import("../api/client")>();
  return {
    ...actual,
    isAuthenticated: () => true,
    getAgentSession: vi.fn(async () => ({
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
    })),
    getAgentSessionHistory: vi.fn(),
    attachAgentSession: vi.fn(),
  };
});

vi.mock("../hooks/useAgentRoles", () => ({
  useAgentRoles: () => [],
}));

import { getAgentSessionHistory } from "../api/client";
import AgentSessionDetailPage from "./AgentSessionDetailPage";

type HistoryCall = { tail?: boolean; before?: string; limit?: number };

function item(
  messageID: string,
  role: AgentSessionHistoryItem["role"],
  text: string,
  kind: AgentSessionHistoryItem["kind"] = "message",
  toolName?: string,
): AgentSessionHistoryItem {
  return {
    agent_id: "claude-code",
    external_ref: "ref-1",
    message_id: messageID,
    kind,
    role,
    tool_name: toolName,
    text,
    occurred_at: 1,
    source_rev: "rev-1",
  };
}

/**
 * One transcript served the way the history route serves it: `tail` is the
 * newest page, `before` walks backwards, and `prev_cursor` is the position of
 * the page's first item. The cursor here is the item index, which is enough to
 * prove which page the console asked for.
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

function openSession() {
  return render(
    <MemoryRouter initialEntries={["/agent-sessions/s1"]}>
      <Routes>
        <Route path="/agent-sessions/:id" element={<AgentSessionDetailPage />} />
      </Routes>
    </MemoryRouter>,
  );
}

afterEach(() => {
  vi.clearAllMocks();
});

describe("AgentSessionDetailPage first-screen budget", () => {
  it("opens a 50-turn session at its newest three turns with one request", async () => {
    const all: AgentSessionHistoryItem[] = [];
    for (let turn = 1; turn <= 50; turn += 1) {
      all.push(item(`u${turn}`, "user", `question ${turn}`));
      all.push(item(`a${turn}`, "assistant", `answer ${turn}`));
    }
    const { impl, calls } = pagedHistory(all);
    vi.mocked(getAgentSessionHistory).mockImplementation(impl);

    openSession();

    await screen.findByText(/question 50/);
    expect(calls).toHaveLength(1);
    // The third-newest user turn (48) and everything after it, and nothing
    // from the fourth (47): the budget is turns, not a fixed message count.
    expect(screen.getByText(/question 48/)).toBeTruthy();
    expect(screen.getByText(/answer 50/)).toBeTruthy();
    expect(screen.queryByText(/question 47/)).toBeNull();
  });

  it("shows a two-turn session whole instead of cutting it at a threshold", async () => {
    const all = [
      item("u1", "user", "question 1"),
      item("a1", "assistant", "answer 1"),
      item("u2", "user", "question 2"),
      item("a2", "assistant", "answer 2"),
    ];
    const { impl, calls } = pagedHistory(all);
    vi.mocked(getAgentSessionHistory).mockImplementation(impl);

    openSession();

    await screen.findByText(/question 2/);
    expect(calls).toHaveLength(1);
    expect(screen.getByText(/question 1/)).toBeTruthy();
    expect(screen.getByText(/answer 1/)).toBeTruthy();
  });

  it("stops reading at the byte ceiling instead of walking a tool-dense turn", async () => {
    // Each turn is one user message plus a wall of tool output. Two pages of
    // thirty items cross the 256 KiB ceiling, so the opening read must stop
    // after the first page even though it has not found three turns yet.
    const longOutput = (tool: number) => `tool ${tool}\n${"x".repeat(5000)}`;
    const all: AgentSessionHistoryItem[] = [item("u1", "user", "run it")];
    for (let tool = 1; tool <= 90; tool += 1) {
      all.push(item(`t${tool}`, "tool", longOutput(tool), "tool_result", "Bash"));
    }
    const { impl, calls } = pagedHistory(all);
    vi.mocked(getAgentSessionHistory).mockImplementation(impl);

    openSession();

    // Tool results collapse into one progress row, so the count in its label
    // is what says how many arrived: thirty from the first page, not sixty.
    await screen.findByText(/Bash × 30/);
    expect(calls).toHaveLength(2);
    expect(screen.queryByText(/Bash × 60/)).toBeNull();
  });

  it("reveals the held-back messages before asking the machine for a page", async () => {
    const all: AgentSessionHistoryItem[] = [];
    for (let turn = 1; turn <= 50; turn += 1) {
      all.push(item(`u${turn}`, "user", `question ${turn}`));
      all.push(item(`a${turn}`, "assistant", `answer ${turn}`));
    }
    const { impl, calls } = pagedHistory(all);
    vi.mocked(getAgentSessionHistory).mockImplementation(impl);

    const { container } = openSession();
    await screen.findByText(/question 50/);
    const scroller = container.querySelector<HTMLElement>(".overflow-y-auto.kin-scroll");
    expect(scroller).not.toBeNull();

    // Scrolling to the top shows what the opening read already held — the
    // fourth turn on — without another request.
    fireEvent.scroll(scroller!, { target: { scrollTop: 0 } });
    await screen.findByText(/question 47/);
    expect(calls).toHaveLength(1);
    expect(screen.getByText(/question 36/)).toBeTruthy();

    // Only after everything held back is on screen does the next scroll ask
    // for the page older than the opening read.
    fireEvent.scroll(scroller!, { target: { scrollTop: 0 } });
    await screen.findByText(/question 35/);
    expect(calls).toHaveLength(2);
  });
});
