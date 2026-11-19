// @vitest-environment jsdom
import { beforeEach, describe, expect, it, vi } from "vitest";
import { fireEvent, render, screen, waitFor } from "@testing-library/react";
import type { ReactNode } from "react";
import { MemoryRouter } from "react-router-dom";
import type { Task } from "../api/client";
import { liveResources } from "../api/liveResources";
import { setLocale, t } from "../i18n";
import { shortPath } from "../lib/paths";
import { useAppStore } from "../store/appStore";
import TaskDetailPage from "./TaskDetailPage";

/**
 * R-chat-outside-file: the page owns the one rule for "can this checkout name
 * this path", and the transcript's file controls obey it.
 *
 * The outside row is still a fact — it was changed — so it stays listed. What
 * goes away is the control that could only ever toast "path is outside this
 * task workspace". The assertion is on the toast *container*, not on the
 * wording: the marker reuses the toast's own sentence, so "the string is not
 * on screen" would pass while a red toast sat over the transcript.
 */

// Lifted with the mock factory, which runs before this module's own bindings
// exist. Nothing here is real infrastructure: `/work` and `/elsewhere` only.
const fixtures = vi.hoisted(() => {
  const inside = "/work/a.ts";
  const outside = "/elsewhere/b.ts";
  const event = (seq: number, type: string, payload: unknown) => ({
    task_id: "task-1",
    event_epoch: 0,
    seq,
    ts: seq,
    type,
    payload,
  });
  return {
    inside,
    outside,
    task: {
      id: "task-1",
      title: "Fix the parser",
      status: "succeeded",
      agent: "kin",
      cwd: "/work",
      prompt: "fix it",
      tokens_in: 0,
      tokens_out: 0,
      event_epoch: 0,
      created_at: 1,
    },
    // One closed round: a user ask, two file writes — one inside the checkout
    // and one outside it — and the answer that settles the turn.
    events: [
      event(1, "message", { role: "user", content: [{ type: "text", text: "go" }] }),
      event(2, "tool_use", {
        speaker: "kin",
        name: "write",
        input: { path: inside, content: "const a = 1;\n" },
      }),
      event(3, "tool_use", {
        speaker: "kin",
        name: "write",
        input: { path: outside, content: "const b = 1;\n" },
      }),
      event(4, "message", {
        role: "assistant",
        speaker: "kin",
        content: [{ type: "text", text: "done" }],
        partial: false,
        message_id: "m1",
        index: 0,
      }),
    ],
  };
});

const INSIDE = fixtures.inside;
const OUTSIDE = fixtures.outside;
const task = fixtures.task as unknown as Task;
const OUTSIDE_WORDING = () => t("workspace.outsideWorkspace");

const panelProbe = vi.hoisted(() => ({
  openPath: null as string | null,
}));

vi.mock("../api/useLiveResources", () => ({
  useTaskResource: (id: string) => ({
    loaded: true,
    error: null,
    id,
    data: {
      task: { ...fixtures.task, id: id || "task-1" },
      events: fixtures.events,
      deleted: false,
    },
  }),
  usePendingResources: () => ({
    loaded: true,
    error: null,
    loading: false,
    data: { approvals: [], questions: [] },
  }),
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
  };
});

vi.mock("../hooks/useMachines", () => ({
  useMachines: () => ({ machines: [], loading: false, failed: false }),
}));
vi.mock("../components/mobile/MobileHeader", () => ({
  default: () => <div data-testid="mobile-header" />,
  MobileHeaderButton: ({ children }: { children?: ReactNode }) => (
    <button type="button">{children}</button>
  ),
}));
vi.mock("../components/chat/Composer", () => ({
  default: () => <div data-testid="composer" />,
}));
vi.mock("../components/workspace/WorkspacePanel", () => ({
  default: ({ openPath }: { openPath?: string | null }) => {
    panelProbe.openPath = openPath ?? null;
    return <div data-testid="workspace-panel" data-open-path={openPath ?? ""} />;
  },
}));

class ResizeObserverStub {
  observe() {}
  unobserve() {}
  disconnect() {}
}

function renderPage() {
  return render(
    <MemoryRouter initialEntries={["/tasks/task-1"]}>
      <TaskDetailPage taskId="task-1" fallbackTask={task} />
    </MemoryRouter>,
  );
}

/** The round card's row for one path, as the disclosure it still is. */
async function expandFileRow(path: string) {
  const matches = await screen.findAllByTitle(path);
  const row = matches.find(
    (node) => node.tagName === "BUTTON" && node.hasAttribute("aria-expanded"),
  );
  if (!row) throw new Error(`no disclosure row for ${path}`);
  fireEvent.click(row);
}

beforeEach(() => {
  vi.stubGlobal("ResizeObserver", ResizeObserverStub);
  Element.prototype.scrollIntoView = vi.fn();
  vi.spyOn(liveResources, "refreshPending").mockResolvedValue(undefined);
  useAppStore.setState({ shownPanel: null, lensPick: null, toasts: [] });
  setLocale("en");
  localStorage.clear();
});

describe("a file outside the task's checkout", () => {
  it("is a marker in the round card, pushes no toast, and the inside file still opens the panel", async () => {
    renderPage();

    // The row itself is a fact and stays on screen.
    await expandFileRow(OUTSIDE);
    const marker = screen.getByText(OUTSIDE_WORDING());
    expect(marker.tagName).not.toBe("BUTTON");
    expect(marker.getAttribute("title")).toBe(OUTSIDE);
    expect(
      screen.queryByRole("button", {
        name: `${t("workspace.openFile")} · ${shortPath(OUTSIDE, 48)}`,
      }),
    ).toBeNull();

    // The wording is the toast's own sentence, so the container is what says
    // nothing was pushed — not the absence of the string.
    expect(useAppStore.getState().toasts).toEqual([]);
    expect(
      screen
        .queryAllByRole("status")
        .filter((node) => node.textContent?.includes(OUTSIDE_WORDING())),
    ).toEqual([]);

    // The in-workspace file still opens the files panel, addressed relative to
    // the checkout.
    await expandFileRow(INSIDE);
    const open = screen.getByRole("button", {
      name: `${t("workspace.openFile")} · ${shortPath(INSIDE, 48)}`,
    });
    fireEvent.click(open);

    await waitFor(() =>
      expect(screen.getByTestId("workspace-panel").getAttribute("data-open-path")).toBe("a.ts"),
    );
    expect(useAppStore.getState().toasts).toEqual([]);

    // Clicking the marker's row again is only the disclosure: no toast, and the
    // panel keeps showing the file the page actually opened.
    fireEvent.click(screen.getByText(shortPath(OUTSIDE, 40)).closest("button")!);
    expect(useAppStore.getState().toasts).toEqual([]);
  });
});
