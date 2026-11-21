// @vitest-environment jsdom
// Shared setup for the two KIN-QUALITY-001 page suites: one fixture set and
// one mock surface, so a dependency change is made once.
import { useSyncExternalStore, type ReactNode } from "react";
import { act, render, screen } from "@testing-library/react";
import { MemoryRouter } from "react-router-dom";
import { vi } from "vitest";
import type { Task, TaskEvent, TaskUsage } from "../api/client";
import { t } from "../i18n";
import Markdown from "../components/Markdown";
import { useAppStore } from "../store/appStore";
import TaskDetailPage from "./TaskDetailPage";
export const task = {
  id: "task-1",
  title: "Read the long answer",
  agent: "kin",
  cwd: "/work/alpha",
  prompt: "read it",
  status: "running",
  tokens_in: 0,
  tokens_out: 0,
  event_epoch: 0,
  created_at: 1,
} as unknown as Task;
export const ANSWER = [
  "The reading surface keeps one header, the body and one composer.",
  "",
  "| Surface | Width | Reading rule |",
  "| --- | --- | --- |",
  "| phone | 390 | one bar, one composer |",
  "| tablet | 820 | compact verbs, table scrolls |",
  "| mac | 1100 | full verbs when they fit |",
  "| wide | 1600 | side rail returns |",
  "",
  "Done.",
].join("\n");
const usage = {
  task_id: "task-1",
  tokens_in: 1200,
  tokens_out: 340,
  request_count: 2,
  reasoning_output_tokens: 0,
  cache_read_tokens: 0,
  cache_write_tokens: 0,
  cache_eligible_input_tokens: 0,
  cache_status: "unknown",
  model_subtotals: [],
  cost_source_subtotals: [],
} as unknown as TaskUsage;
const seedEvents = () =>
  [
    {
      seq: 1,
      type: "message",
      payload: { role: "assistant", speaker: "kin", text: ANSWER, model: "test-model" },
      created_at: 1,
    },
    {
      seq: 2,
      type: "tool_use",
      payload: { name: "write_file", input: { path: "notes.md", content: "a\nb\n" } },
      created_at: 2,
    },
    {
      seq: 3,
      type: "tool_use",
      payload: {
        name: "edit_file",
        input: { path: "src/app.ts", old_string: "a", new_string: "b" },
      },
      created_at: 3,
    },
  ] as unknown as TaskEvent[];
const shared = vi.hoisted(() => {
  const listeners = new Set<() => void>();
  const state = { version: 0, events: [] as unknown[] };
  const notify = () => {
    state.version += 1;
    for (const listener of listeners) listener();
  };
  return {
    detail: { state: { error: null as Error | null } },
    store: {
      state,
      subscribe(listener: () => void) {
        listeners.add(listener);
        return () => {
          listeners.delete(listener);
        };
      },
      version: () => state.version,
      append(event: unknown) {
        state.events = [...state.events, event];
        notify();
      },
      reset(events: unknown[] = []) {
        state.events = events;
        notify();
      },
    },
    pending: {
      state: {
        loaded: true,
        error: null,
        loading: false,
        data: { approvals: [] as unknown[], questions: [] as unknown[] },
      },
    },
  };
});
export const detail = shared.detail;
export const store = shared.store;
export const pending = shared.pending;
vi.mock("../api/useLiveResources", () => ({
  useTaskResource: (id: string) => {
    useSyncExternalStore(shared.store.subscribe, shared.store.version, shared.store.version);
    return {
      loaded: true,
      error: shared.detail.state.error,
      data: {
        task: { ...task, id },
        events: shared.store.state.events as TaskEvent[],
        deleted: false,
      },
      id,
    };
  },
  usePendingResources: () => shared.pending.state,
}));
vi.mock("../api/client", async (importOriginal) => {
  const actual = await importOriginal<typeof import("../api/client")>();
  const never = () => new Promise<never>(() => {});
  return {
    ...actual,
    isAuthenticated: () => true,
    listAgents: never,
    getTaskUsage: () => Promise.resolve(usage),
    getTaskLimitWait: never,
    listQueuedPrompts: never,
    listWorkerSteps: never,
    recentCwds: () => Promise.resolve([]),
    listGitBranches: () => Promise.resolve({ cwd: "/work/alpha", is_git: false, branches: [] }),
  };
});
// No side rail below 1600: 820/1100 carry usage in the composer footer.
vi.mock("../hooks/useMinWidth", () => ({ useMinWidth: (px: number) => px < 1600 }));
vi.mock("../hooks/useMachines", () => ({
  useMachines: () => ({ machines: [], loading: false, failed: false }),
}));
vi.mock("../components/mobile/MobileHeader", () => ({
  default: ({ title }: { title?: string }) => <div data-testid="mobile-header">{title}</div>,
  MobileHeaderButton: ({ children }: { children?: ReactNode }) => <span>{children}</span>,
}));
vi.mock("../components/chat/Composer", () => ({
  default: ({ footer, initialValue }: { footer?: ReactNode; initialValue?: string }) => (
    <div data-testid="composer" data-draft={initialValue ?? ""}>
      {footer}
    </div>
  ),
}));
vi.mock("../components/chat/ChatStream", () => ({
  default: ({
    pendingSlots,
    trailing,
  }: {
    pendingSlots?: Record<string, ReactNode>;
    trailing?: ReactNode;
  }) => (
    <div data-testid="chat-stream">
      <Markdown text={ANSWER} />
      {Object.entries(pendingSlots ?? {}).map(([id, node]) => (
        <div key={id}>{node}</div>
      ))}
      {trailing}
    </div>
  ),
}));
/** The page measures its column; a jsdom render reports 520 px on demand. */
type ResizeCallback = (entries: ResizeObserverEntry[]) => void;
export const resizers: { callback: ResizeCallback; targets: Set<Element> }[] = [];
class ResizeObserverStub {
  targets = new Set<Element>();
  constructor(readonly callback: ResizeCallback) {
    resizers.push(this);
  }
  observe(target: Element) {
    this.targets.add(target);
  }
  unobserve(target: Element) {
    this.targets.delete(target);
  }
  disconnect() {
    this.targets.clear();
  }
}
export function pageTree() {
  return (
    <MemoryRouter initialEntries={["/tasks/task-1"]}>
      <TaskDetailPage taskId="task-1" fallbackTask={task} />
    </MemoryRouter>
  );
}
export function renderPage() {
  return render(pageTree());
}
export function resetPage() {
  detail.state.error = null;
  pending.state.data = { approvals: [], questions: [] };
  store.reset(seedEvents());
  useAppStore.setState({ wsStatus: "connected" });
  resizers.length = 0;
  Element.prototype.scrollIntoView = vi.fn();
  vi.stubGlobal("ResizeObserver", ResizeObserverStub);
}
export function cleanupPage() {
  vi.unstubAllGlobals();
  vi.restoreAllMocks();
  resizers.length = 0;
}
export function conversationColumn(container: HTMLElement) {
  const column = container.querySelector(".kin-surface-chat") as HTMLElement | null;
  if (!column) throw new Error("no conversation column");
  return column;
}
export function desktopBar(container: HTMLElement) {
  // MobileHeader is mocked as a div; the desktop bar is its next sibling.
  return conversationColumn(container).querySelector<HTMLElement>(
    '[data-testid="mobile-header"] + div',
  )!;
}
export function reportColumnWidth(width: number) {
  const column = document.querySelector(".kin-surface-chat") as HTMLElement;
  const observer = resizers.find((candidate) => candidate.targets.has(column));
  if (!observer) throw new Error("the page did not observe its column");
  act(() => {
    observer.callback([
      { target: column, contentRect: { width } } as unknown as ResizeObserverEntry,
    ]);
  });
}
export function newActivityButton() {
  return screen.queryByRole("button", { name: t("task.newActivity") });
}
