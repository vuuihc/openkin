// @vitest-environment jsdom
import { beforeEach, describe, expect, it, vi } from "vitest";
import { render } from "@testing-library/react";
import { MemoryRouter } from "react-router-dom";
import AppShell from "./AppShell";
import { setLocale } from "../../i18n";
import { useAppStore } from "../../store/appStore";

/**
 * R-ios-bottom-band: the safe-area band below the content belongs to the
 * surface the person is looking at.
 *
 * `.safe-pad` spends the bottom inset as `padding-bottom` on the shell root
 * (`index.css`), so the root's background is what paints the 34pt strip under
 * every page. A single fixed `--kin-page` there made the strip grey under a
 * conversation (`--kin-bg`) and under the files panel (`--kin-inspector`).
 * The shell already knows which surface is in front (`panelOpen`,
 * `selectedTaskId`, `draftActive`), so the tone is derived, never stored.
 */

const { viewport, taskHolder } = vi.hoisted(() => ({
  viewport: { width: 390 },
  taskHolder: { task: undefined as { id: string } | undefined },
}));

vi.mock("../../api/useLiveResources", () => ({
  useTaskList: () => ({
    data: [],
    loaded: true,
    error: null,
    pageFull: false,
    loading: false,
  }),
  useTaskResource: () => ({ data: { task: taskHolder.task }, loaded: true, error: null }),
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

vi.mock("../../hooks/useMinWidth", () => ({
  useMinWidth: (px: number) => viewport.width >= px,
}));
vi.mock("../../hooks/useApprovalDecision", () => ({
  useApprovalDecision: () => ({ busy: {}, decide: vi.fn() }),
}));
vi.mock("../../lib/desktop", () => ({ isKinDesktop: vi.fn(() => false) }));
vi.mock("../terminal/TerminalPanel", () => ({ default: () => null }));

const TONES = [
  "bg-[var(--kin-page)]",
  "bg-[var(--kin-bg)]",
  "bg-[var(--kin-inspector)]",
] as const;

function shell(initialEntry: string) {
  const rendered = render(
    <MemoryRouter initialEntries={[initialEntry]}>
      <AppShell pendingApprovals={[]}>
        <div />
      </AppShell>
    </MemoryRouter>,
  );
  const root = rendered.container.firstElementChild as HTMLElement;
  return { ...rendered, root };
}

function toneOf(element: HTMLElement): string[] {
  return TONES.filter((tone) => element.classList.contains(tone));
}

beforeEach(() => {
  setLocale("en");
  sessionStorage.clear();
  localStorage.clear();
  useAppStore.getState().setWSStatus("connected");
  useAppStore.setState({ shownPanel: null });
  taskHolder.task = undefined;
  viewport.width = 390;
});

describe("the shell root's safe-area tone", () => {
  it("paints a conversation's root with --kin-bg", () => {
    const { root } = shell("/tasks/t1");
    expect(toneOf(root)).toEqual(["bg-[var(--kin-bg)]"]);
  });

  it("paints the files panel's root with --kin-inspector", () => {
    // `files` is offered whenever the session resolves (`PANELS`): the shell
    // has to see the task the page sees, or the panel closes in the fixture
    // and the assertion would be checking the wrong surface.
    taskHolder.task = { id: "t1" };
    useAppStore.setState({ shownPanel: { view: "t1", id: "files" } });
    const { root } = shell("/tasks/t1");
    expect(toneOf(root)).toEqual(["bg-[var(--kin-inspector)]"]);
  });

  it("paints the draft's root with --kin-bg", () => {
    const { root } = shell("/new");
    expect(toneOf(root)).toEqual(["bg-[var(--kin-bg)]"]);
  });

  it("keeps --kin-page on the list, settings and routines", () => {
    for (const route of ["/sessions", "/settings", "/routines"]) {
      const { root, unmount } = shell(route);
      expect(toneOf(root), `tone at ${route}`).toEqual(["bg-[var(--kin-page)]"]);
      unmount();
    }
  });

  it("keeps exactly one tone class and the safe-pad on every root", () => {
    const routes = ["/tasks/t1", "/new", "/sessions", "/settings", "/routines"];
    for (const route of routes) {
      const { root, unmount } = shell(route);
      expect(toneOf(root), `exactly one tone at ${route}`).toHaveLength(1);
      expect(root.classList.contains("safe-pad"), `safe-pad at ${route}`).toBe(true);
      expect(root.classList.contains("h-[100dvh]"), `height at ${route}`).toBe(true);
      unmount();
    }

    taskHolder.task = { id: "t1" };
    useAppStore.setState({ shownPanel: { view: "t1", id: "files" } });
    const { root, unmount } = shell("/tasks/t1");
    expect(toneOf(root), "exactly one tone under the files panel").toHaveLength(1);
    expect(root.classList.contains("safe-pad")).toBe(true);
    expect(root.classList.contains("h-[100dvh]")).toBe(true);
    unmount();
  });
});
