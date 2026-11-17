// @vitest-environment jsdom
import type { ReactNode } from "react";
import { act, render, screen, within } from "@testing-library/react";
import { MemoryRouter } from "react-router-dom";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import type { Task } from "../api/client";
import { setLocale, t } from "../i18n";
import TaskDetailPage from "./TaskDetailPage";

/**
 * RSI item R-approval-dup-cta: one approval, one 批准 on screen.
 *
 * The card in the transcript carries Approve and Deny. The band above the
 * composer is the locator for a card that may be a screen or two above the
 * fold, and it used to carry the same Approve unconditionally — two primaries
 * for one decision, which the one-primary rule forbids. The page now watches
 * the oldest waiting card through the transcript scroller and tells the band
 * whether that card is visible; the band keeps its row either way and drops
 * only the duplicate action.
 *
 * What this test pins is the wiring between the two: the observer is attached
 * to the actual card node, the dock's Approve disappears while that node is
 * on screen, and it comes back the moment the reader scrolls it away. A page
 * that passed a constant `false` would leave two 批准 buttons up and fail the
 * first assertion after the card is reported visible.
 */

const task: Task = {
  id: "task-1",
  title: "Fix the login bug",
  status: "running",
  agent: "kin",
  cwd: "/work/alpha",
  prompt: "fix it",
  tokens_in: 0,
  tokens_out: 0,
  event_epoch: 0,
  created_at: 1,
} as unknown as Task;

const pending = {
  loaded: true,
  error: null,
  loading: false,
  data: {
    approvals: [
      {
        id: "ap-only",
        task_id: "task-1",
        kind: "tool_use",
        payload: { tool_name: "Write", input: { path: "a.ts" } },
        decision: "pending",
        created_at: 1,
      },
    ],
    questions: [],
  },
};

vi.mock("../api/useLiveResources", () => ({
  // No events, so the card has no anchor and is painted at the end of the
  // stream — still inside the transcript scroller, which is what the page
  // observes.
  useTaskResource: (id: string) => ({
    loaded: true,
    error: null,
    data: { task: { ...task, id }, events: [], deleted: false },
    id,
  }),
  usePendingResources: () => pending,
}));

vi.mock("../api/client", async (importOriginal) => {
  const actual = await importOriginal<typeof import("../api/client")>();
  const never = () => new Promise<never>(() => {});
  return {
    ...actual,
    isAuthenticated: () => true,
    listAgents: never,
    getTaskUsage: never,
    getTaskLimitWait: never,
    listQueuedPrompts: never,
    listWorkerSteps: never,
    // The dock's folder and branch chips ask on mount; not the subject here.
    recentCwds: () => Promise.resolve([]),
    listGitBranches: () => Promise.resolve({ cwd: "/work/alpha", is_git: false, branches: [] }),
  };
});

vi.mock("../hooks/useMachines", () => ({
  useMachines: () => ({ machines: [], loading: false, failed: false }),
}));
vi.mock("../components/mobile/MobileHeader", () => ({
  default: ({ title }: { title?: string }) => <div data-testid="mobile-header">{title}</div>,
  MobileHeaderButton: ({ children }: { children?: ReactNode }) => (
    <button type="button">{children}</button>
  ),
}));
vi.mock("../components/chat/Composer", () => ({
  default: () => <div data-testid="composer" />,
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
      {Object.entries(pendingSlots ?? {}).map(([id, node]) => (
        <div key={id}>{node}</div>
      ))}
      {trailing}
    </div>
  ),
}));

/**
 * jsdom has no `IntersectionObserver`. The page guards for it, so leaving it
 * out would silently exercise the off-screen fallback and never prove the
 * wiring. This stub records the callback and the observed node so the test
 * can report visibility as the browser would.
 */
type StubCallback = (entries: IntersectionObserverEntry[], observer: IntersectionObserver) => void;

const observers: StubObserver[] = [];

class StubObserver {
  readonly callback: StubCallback;
  readonly targets = new Set<Element>();
  disconnected = false;

  constructor(callback: StubCallback) {
    this.callback = callback;
    observers.push(this);
  }

  observe(target: Element) {
    this.targets.add(target);
  }

  unobserve(target: Element) {
    this.targets.delete(target);
  }

  disconnect() {
    this.disconnected = true;
  }

  takeRecords(): IntersectionObserverEntry[] {
    return [];
  }
}

class ResizeObserverStub {
  observe() {}
  unobserve() {}
  disconnect() {}
}

function open() {
  return render(
    <MemoryRouter initialEntries={["/tasks/task-1"]}>
      <TaskDetailPage taskId="task-1" fallbackTask={task} />
    </MemoryRouter>,
  );
}

function approveButtons() {
  // Both controls say the same word: the card states it through `aria-label`,
  // the dock through its visible label.
  return screen.getAllByRole("button", { name: new RegExp(t("chat.approve")) });
}

function report(observer: StubObserver, target: Element, isIntersecting: boolean) {
  act(() => {
    observer.callback(
      [{ target, isIntersecting } as IntersectionObserverEntry],
      observer as unknown as IntersectionObserver,
    );
  });
}

beforeEach(() => {
  observers.length = 0;
  vi.stubGlobal("IntersectionObserver", StubObserver);
  vi.stubGlobal("ResizeObserver", ResizeObserverStub);
  Element.prototype.scrollIntoView = vi.fn();
  setLocale("en");
  localStorage.clear();
});

afterEach(() => {
  vi.unstubAllGlobals();
  vi.restoreAllMocks();
  observers.length = 0;
});

describe("the pinned approval row", () => {
  it("drops 批准 only while the oldest approval card is on screen", () => {
    open();

    const card = document.querySelector('[data-pending-id="ap-only"]');
    expect(card).not.toBeNull();

    // The page watches the card itself, at the transcript scroller — not the
    // scroll offset, which lies for a card taller than its viewport.
    const observer = observers.find((candidate) => candidate.targets.has(card!));
    expect(observer).toBeDefined();

    // The dock's row is the element that carries 查看; the card has its own
    // title, so the locator assertion is scoped to that row rather than the
    // whole screen.
    const view = () => screen.getByRole("button", { name: t("task.viewPending") });
    const locator = () => within(view().parentElement!).getByText(t("approval.cardTitle"));

    // Starting state: the card is out of view, so the band carries the
    // decision as well as the locator.
    expect(approveButtons()).toHaveLength(2);
    expect(locator()).toBeTruthy();
    expect(view()).toBeTruthy();

    // The reader scrolls the card into view. Its own Approve and Deny are now
    // the only decision controls; the band keeps naming the decision and
    // taking the reader to it.
    report(observer!, card!, true);
    const visible = approveButtons();
    expect(visible).toHaveLength(1);
    expect(card!.contains(visible[0])).toBe(true);
    expect(locator()).toBeTruthy();
    expect(view()).toBeTruthy();

    // Scrolled away again: the band's Approve is the one within reach.
    report(observer!, card!, false);
    expect(approveButtons()).toHaveLength(2);
    expect(locator()).toBeTruthy();
    expect(view()).toBeTruthy();
  });
});
