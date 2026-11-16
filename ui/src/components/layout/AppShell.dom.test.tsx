// @vitest-environment jsdom
import { beforeEach, describe, expect, it, vi } from "vitest";
import { render } from "@testing-library/react";
import { MemoryRouter } from "react-router-dom";
import AppShell, {
  CONVERSATION_MIN,
  LIST_COLUMN,
  PANEL_COLUMN,
  conversationWidth,
} from "./AppShell";
import { setLocale } from "../../i18n";
import { useAppStore } from "../../store/appStore";
import { refreshMachines } from "../../hooks/useMachines";
import { isKinDesktop } from "../../lib/desktop";
import { SHELL_VIEW } from "../../lib/panels";

/**
 * S1b: the list column yields to an open session panel.
 *
 * The panel used to paint over the conversation while the 304px list column
 * stayed behind it, so the reader lost both the chat and the width the diff
 * needed. The rule is one surface at a time: while a panel is open for the
 * conversation in front, the list is not drawn; "Show list" brings it back by
 * closing the panel (`TaskHeader`).
 *
 * The width floor is a pure function rather than a DOM measurement, because
 * jsdom has no layout: `conversationWidth` is the arithmetic the classes
 * encode, and the test is what keeps it above TASTE's 420px.
 */

const { viewport } = vi.hoisted(() => ({ viewport: { width: 1280 } }));

vi.mock("../../api/useLiveResources", () => ({
  useTaskList: () => ({
    data: [],
    loaded: true,
    error: null,
    pageFull: false,
    loading: false,
  }),
  useTaskResource: () => ({ data: { task: undefined }, loaded: true, error: null }),
  usePendingResources: () => ({
    data: { approvals: [], questions: [] },
    loaded: true,
    error: null,
  }),
}));

vi.mock("../../api/client", async (importOriginal) => {
  const actual = await importOriginal<typeof import("../../api/client")>();
  return {
    ...actual,
    listAgentSessionsPage: vi.fn(async () => ({ items: [], next_cursor: undefined })),
    listProjects: vi.fn(async () => []),
    ensureProject: vi.fn(async () => ({ id: "project-1", name: "alpha" })),
    getSettings: vi.fn(async () => ({})),
    getUsageSummary: vi.fn(async () => []),
    listAgents: vi.fn(async () => []),
    serverVersion: vi.fn().mockResolvedValue({ desktop_id: "desktop-hub", desktop_name: "hub" }),
    listMachines: vi.fn().mockResolvedValue([]),
  };
});

vi.mock("../../hooks/useMachines", () => ({
  useMachines: () => ({
    machines: [
      { id: "mac-1", label: "MacBook", isSelf: true, online: true, roots: [], agents: [] },
    ],
    loading: false,
    failed: false,
  }),
  refreshMachines: vi.fn(async () => []),
}));

// The shell asks `useMinWidth(768)` and `useMinWidth(1280)`; the answer has to
// come from one number so a case can say "1100" and get a 768-wide shell whose
// rail is still compact.
vi.mock("../../hooks/useMinWidth", () => ({
  useMinWidth: (px: number) => viewport.width >= px,
}));
vi.mock("../../hooks/useApprovalDecision", () => ({
  useApprovalDecision: () => ({ busy: {}, decide: vi.fn() }),
}));
vi.mock("../../lib/desktop", () => ({ isKinDesktop: vi.fn(() => false) }));
vi.mock("../terminal/TerminalPanel", () => ({ default: () => null }));

function shell(initialEntry: string) {
  return render(
    <MemoryRouter initialEntries={[initialEntry]}>
      <AppShell pendingApprovals={[]}>
        <div />
      </AppShell>
    </MemoryRouter>,
  );
}

const listColumn = (container: HTMLElement) => container.querySelector("[data-kin-list-column]");

beforeEach(() => {
  setLocale("en");
  sessionStorage.clear();
  localStorage.clear();
  useAppStore.getState().setWSStatus("connected");
  useAppStore.setState({ shownPanel: null });
  vi.mocked(isKinDesktop).mockReturnValue(false);
  vi.mocked(refreshMachines).mockReset().mockResolvedValue([]);
  viewport.width = 1280;
});

describe("the Mac list column", () => {
  it("hides the conversation list while a session panel is open", () => {
    useAppStore.setState({ shownPanel: { view: "task-1", id: "files" } });

    for (const width of [1100, 1280]) {
      viewport.width = width;
      const { container, unmount } = shell("/tasks/task-1");
      expect(listColumn(container), `list should yield at ${width}px`).toBeNull();
      unmount();
    }
  });

  it("keeps the list when the panel belongs to another view", () => {
    // A panel opened in one conversation must not hide another's list.
    useAppStore.setState({ shownPanel: { view: "task-2", id: "files" } });
    const { container } = shell("/tasks/task-1");
    expect(listColumn(container)).not.toBeNull();
  });

  it("keeps the list while the shell's own panel is open", () => {
    // The terminal's view key is the shell's, not a conversation's.
    useAppStore.setState({ shownPanel: { view: SHELL_VIEW, id: "terminal" } });
    const { container } = shell("/tasks/task-1");
    expect(listColumn(container)).not.toBeNull();
  });

  it("keeps the list when no panel is open", () => {
    const { container } = shell("/tasks/task-1");
    expect(listColumn(container)).not.toBeNull();
  });
});

describe("conversationWidth", () => {
  it("keeps the conversation at or above 420px beside an open panel", () => {
    for (const width of [1100, 1280, 1440]) {
      expect(
        conversationWidth({ window: width, rail: 64, listShown: false, panel: PANEL_COLUMN }),
        `conversation at ${width}px`,
      ).toBeGreaterThanOrEqual(CONVERSATION_MIN);
    }
    // …which is why the list yields: the same window with the list still
    // drawn is under the floor.
    expect(
      conversationWidth({ window: 1100, rail: 64, listShown: true, panel: PANEL_COLUMN }),
    ).toBeLessThan(CONVERSATION_MIN);
  });

  it("counts the list column only while it is drawn", () => {
    const geometry = { window: 1100, rail: 64, panel: null };
    expect(conversationWidth({ ...geometry, listShown: true })).toBe(1100 - 64 - LIST_COLUMN);
    expect(conversationWidth({ ...geometry, listShown: false })).toBe(1100 - 64);
  });
});
