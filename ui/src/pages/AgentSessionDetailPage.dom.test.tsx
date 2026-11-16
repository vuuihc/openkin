// @vitest-environment jsdom
import { afterEach, describe, expect, it, vi } from "vitest";
import { fireEvent, render, screen, waitFor } from "@testing-library/react";
import { MemoryRouter, Route, Routes } from "react-router-dom";
import type { AgentSession, AgentSessionHistoryPage } from "../api/client";

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

import AgentSessionDetailPage from "./AgentSessionDetailPage";

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
