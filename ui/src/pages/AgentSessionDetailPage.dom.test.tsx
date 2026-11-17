// @vitest-environment jsdom
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { fireEvent, render, screen, waitFor, within } from "@testing-library/react";
import userEvent from "@testing-library/user-event";
import { MemoryRouter, Route, Routes } from "react-router-dom";
import type { AgentSession, AgentSessionHistoryItem, AgentSessionHistoryPage } from "../api/client";
import { DEFAULT_LOCALE, setLocale } from "../i18n";

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
};

vi.mock("../api/client", async (importOriginal) => {
  const actual = await importOriginal<typeof import("../api/client")>();
  return {
    ...actual,
    isAuthenticated: () => true,
    getAgentSession: vi.fn(async () => session),
    getAgentSessionHistory: vi.fn(async (): Promise<AgentSessionHistoryPage> => ({
      items: [
        {
          agent_id: "claude-code",
          external_ref: "ref-1",
          message_id: "m1",
          kind: "message",
          role: "assistant",
          text: "the newest message",
          occurred_at: 2,
          source_rev: "rev-1",
        },
      ],
      prev_cursor: "",
    })),
    attachAgentSession: vi.fn(),
  };
});

vi.mock("../hooks/useAgentRoles", () => ({
  useAgentRoles: () => [],
}));

import { getAgentSession, getAgentSessionHistory } from "../api/client";
import AgentSessionDetailPage from "./AgentSessionDetailPage";

function historyItem(
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

function renderPage() {
  return render(
    <MemoryRouter initialEntries={["/agent-sessions/s1"]}>
      <Routes>
        <Route path="/agent-sessions/:id" element={<AgentSessionDetailPage />} />
        <Route path="/sessions" element={<div>session list</div>} />
      </Routes>
    </MemoryRouter>,
  );
}

// KIN-CONTINUE-003 row 12: an imported session opened from a list, a project
// or Settings → Agent Ops keeps its source entry and every original control.

/**
 * Opening a large session lands on what happened last, and stays there while
 * the page finishes laying out.
 *
 * The first scroll happens in the commit that inserts the messages, but
 * screenshots and long code blocks inside them add height afterwards. Without
 * following the growth, the one scroll at commit time leaves the reader
 * partway up a transcript they asked to open at its end.
 */
describe("AgentSessionDetailPage opening position", () => {
  afterEach(() => {
    vi.unstubAllGlobals();
  });

  it("keeps the end in view while the transcript grows, until the reader scrolls up", async () => {
    const callbacks: Array<() => void> = [];
    class Observer {
      constructor(private readonly callback: ResizeObserverCallback) {
        callbacks.push(() => this.callback([], this as unknown as ResizeObserver));
      }
      observe() {}
      unobserve() {}
      disconnect() {}
    }
    vi.stubGlobal("ResizeObserver", Observer);

    const { container } = render(
      <MemoryRouter initialEntries={["/agent-sessions/s1"]}>
        <Routes>
          <Route path="/agent-sessions/:id" element={<AgentSessionDetailPage />} />
        </Routes>
      </MemoryRouter>,
    );

    await screen.findByText(/the newest message/);
    const scroller = container.querySelector<HTMLElement>(".overflow-y-auto.kin-scroll");
    expect(scroller).not.toBeNull();
    let height = 1000;
    Object.defineProperty(scroller!, "scrollHeight", { configurable: true, get: () => height });
    // jsdom has no layout, so the observer is the test's to fire: that is what
    // the browser does when the content box changes. The opening scroll is the
    // page's own, and it has already run by the time the messages are found.
    expect(callbacks.length).toBeGreaterThan(0);
    for (const fire of callbacks) fire();
    await waitFor(() => expect(scroller!.scrollTop).toBe(1000));

    height = 2400;
    for (const fire of callbacks) fire();
    expect(scroller!.scrollTop).toBe(2400);

    fireEvent.scroll(scroller!, { target: { scrollTop: 300 } });
    scroller!.scrollTop = 300;
    height = 3000;
    for (const fire of callbacks) fire();
    expect(scroller!.scrollTop).toBe(300);
  });
});

describe("AgentSessionDetailPage controls", () => {
  beforeEach(() => {
    // The accessible names below are the English catalogue's, so a missing or
    // renamed key fails here rather than falling back to a dotted path.
    setLocale("en");
    vi.mocked(getAgentSession).mockReset();
    vi.mocked(getAgentSession).mockResolvedValue(session);
    vi.mocked(getAgentSessionHistory).mockReset();
  });

  afterEach(() => {
    setLocale(DEFAULT_LOCALE);
  });

  it("puts the agent-session controls on the shared button facade", async () => {
    // The opening read fails, which still leaves the header and its back
    // control on screen: the session itself loaded.
    vi.mocked(getAgentSessionHistory).mockRejectedValueOnce(new Error("history failed"));
    const first = renderPage();

    await screen.findByText("history failed");
    const back = screen.getByRole("button", { name: "Back to chats" });
    expect(back.className).toContain("kin-btn");
    // The quiet weight: transparent at rest, no filled or bordered sibling.
    expect(back.className).toContain("bg-transparent");
    expect(back.className).not.toContain("kin-btn-primary");
    expect(back.className).not.toContain("kin-btn-secondary");

    // It still goes where it went: the list is this screen's parent.
    await userEvent.click(back);
    await screen.findByText("session list");
    first.unmount();

    // A tail read that failed offers its retry; the retry re-reads the newest
    // page rather than only repainting the error.
    vi.mocked(getAgentSessionHistory)
      .mockRejectedValueOnce(new Error("tail page failed"))
      .mockResolvedValueOnce({
        items: [historyItem("m1", "assistant", "the newest message")],
        prev_cursor: "",
      });
    const second = renderPage();

    await screen.findByText("tail page failed");
    const tailRetry = screen.getByRole("button", { name: "Try again" });
    expect(tailRetry.className).toContain("kin-btn");
    expect(tailRetry.className).toContain("kin-btn-secondary");
    await userEvent.click(tailRetry);
    await screen.findByText(/the newest message/);
    second.unmount();

    // An older page that failed offers its own retry; clicking it asks for the
    // same page again and prepends what arrives.
    const history = vi.mocked(getAgentSessionHistory);
    history
      .mockResolvedValueOnce({
        items: [
          historyItem("u1", "user", "question 1"),
          historyItem("u2", "user", "question 2"),
          historyItem("u3", "user", "question 3"),
        ],
        prev_cursor: "p1",
      })
      .mockRejectedValueOnce(new Error("older page failed"))
      .mockResolvedValueOnce({
        items: [historyItem("u0", "user", "question 0")],
        prev_cursor: "",
      });
    const third = renderPage();

    await screen.findByText(/question 3/);
    const scroller = third.container.querySelector<HTMLElement>(".overflow-y-auto.kin-scroll");
    expect(scroller).not.toBeNull();
    fireEvent.scroll(scroller!, { target: { scrollTop: 0 } });
    await screen.findByText("older page failed");
    const olderRetry = screen.getByRole("button", { name: "Try again" });
    expect(olderRetry.className).toContain("kin-btn");
    expect(olderRetry.className).toContain("kin-btn-secondary");
    await userEvent.click(olderRetry);
    await screen.findByText(/question 0/);
    third.unmount();
  });

  it("keeps the bottom-chrome marker and the continue box", async () => {
    // The floating approval measures this band, so the marker is a contract
    // and not decoration: the continue box lives inside it.
    vi.mocked(getAgentSession).mockResolvedValue({
      ...session,
      capabilities: ["session_attach"],
    });
    vi.mocked(getAgentSessionHistory).mockResolvedValueOnce({
      items: [historyItem("m1", "assistant", "the newest message")],
      prev_cursor: "",
    });
    const { container } = renderPage();

    await screen.findByText(/the newest message/);
    const band = container.querySelector<HTMLElement>('[data-kin-bottom-chrome=""]');
    expect(band).not.toBeNull();
    expect(within(band!).getByPlaceholderText(/Send the next message/)).toBeTruthy();
  });
});
