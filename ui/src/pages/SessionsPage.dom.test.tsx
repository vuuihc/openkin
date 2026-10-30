// @vitest-environment jsdom
import { beforeEach, describe, expect, it, vi } from "vitest";
import { render, screen } from "@testing-library/react";
import { MemoryRouter } from "react-router-dom";
import type { Task } from "../api/client";
import { setLocale } from "../i18n";
import SessionsRoute from "./SessionsRoute";
import Sidebar from "../components/layout/Sidebar";

/**
 * KIN-CONTINUE-001: one list per width.
 *
 * On a Mac `/sessions` is the draft, because the sidebar already holds the only
 * conversation list. On a phone the page *is* the list. The K panel is entries
 * only — new chat, import, inbox, archive, artifacts, routines, agent ops,
 * settings — with no second copy of the list and no second search field.
 */

vi.mock("./NewChatPage", () => ({
  default: () => <div>draft page</div>,
}));
vi.mock("./SessionsPage", () => ({
  default: () => <div>conversation list</div>,
}));
vi.mock("../hooks/useMachines", () => ({
  useMachines: () => ({
    machines: [
      { id: "mac-1", label: "MacBook", isSelf: true, online: true, roots: [], agents: [] },
    ],
    loading: false,
    failed: false,
  }),
}));

function viewport(wide: boolean) {
  vi.stubGlobal("matchMedia", (query: string) => ({
    matches: query === "(min-width: 768px)" ? wide : false,
    media: query,
    onchange: null,
    addEventListener: vi.fn(),
    removeEventListener: vi.fn(),
    addListener: vi.fn(),
    removeListener: vi.fn(),
    dispatchEvent: vi.fn(),
  }));
}

const task = {
  id: "hidden-conversation",
  title: "hidden conversation",
  cwd: "/work/alpha",
  agent: "kin",
  prompt: "",
  status: "succeeded",
  tokens_in: 0,
  tokens_out: 0,
  event_epoch: 0,
  created_at: 1,
} as Task;

beforeEach(() => {
  setLocale("en");
  localStorage.clear();
});

describe("the /sessions route", () => {
  it("shows the draft on a Mac, not a second list", () => {
    viewport(true);
    render(
      <MemoryRouter initialEntries={["/sessions"]}>
        <SessionsRoute />
      </MemoryRouter>,
    );
    expect(screen.getByText("draft page")).toBeTruthy();
    expect(screen.queryByText("conversation list")).toBeNull();
  });

  it("shows the list on a phone", () => {
    viewport(false);
    render(
      <MemoryRouter initialEntries={["/sessions"]}>
        <SessionsRoute />
      </MemoryRouter>,
    );
    expect(screen.getByText("conversation list")).toBeTruthy();
    expect(screen.queryByText("draft page")).toBeNull();
  });

  it("keeps one list on a Mac when an archived address is opened", () => {
    // `?scope=archived` selects the sidebar's archived section; it must not
    // bring a second list and a second search field back into the main area.
    viewport(true);
    render(
      <MemoryRouter initialEntries={["/sessions?scope=archived"]}>
        <SessionsRoute />
      </MemoryRouter>,
    );
    expect(screen.getByText("draft page")).toBeTruthy();
    expect(screen.queryByText("conversation list")).toBeNull();
  });
});

describe("the phone's K panel", () => {
  it("holds entries only — no conversation rows and no search field", () => {
    viewport(false);
    render(
      <MemoryRouter>
        <Sidebar
          tasks={[task]}
          pendingCount={0}
          mobileOpen
          onCloseMobile={() => {}}
          onNewChat={() => {}}
        />
      </MemoryRouter>,
    );

    expect(screen.queryByRole("searchbox")).toBeNull();
    expect(screen.queryByText("hidden conversation")).toBeNull();

    for (const entry of [
      "New chat",
      "Inbox",
      "Archived",
      "Artifacts",
      "Routines",
      "Agent Ops",
      "Settings",
    ]) {
      expect(screen.getByText(entry), `missing entry: ${entry}`).toBeTruthy();
    }
  });
});
