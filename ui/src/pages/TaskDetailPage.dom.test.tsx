// @vitest-environment jsdom
import { useSyncExternalStore } from "react";
import { beforeEach, describe, expect, it, vi } from "vitest";
import { act, render, screen, waitFor } from "@testing-library/react";
import userEvent from "@testing-library/user-event";
import { MemoryRouter, useNavigate } from "react-router-dom";
import { setLocale } from "../i18n";
import TaskSessionHost from "./TaskSessionHost";

/**
 * KIN-CONTINUE-001, step 3 and the two-surface rule: switching conversations
 * updates the conversation area only.
 *
 * The window keeps one shell — sidebar, tab strip, composer — and the outgoing
 * conversation stays readable until the next one has content. What must not
 * happen is the whole area collapsing into a skeleton for the length of a
 * fetch, which is what the old host did and what made switching flash white.
 */

const store = vi.hoisted(() => {
  const listeners = new Set<() => void>();
  const state = {
    version: 0,
    loaded: {} as Record<string, boolean>,
    tasks: {} as Record<string, { id: string; status: string }>,
  };
  return {
    state,
    set(id: string, loaded: boolean) {
      state.loaded[id] = loaded;
      state.version += 1;
      for (const listener of listeners) listener();
    },
    subscribe(listener: () => void) {
      listeners.add(listener);
      return () => listeners.delete(listener);
    },
    version: () => state.version,
  };
});

vi.mock("../api/useLiveResources", () => ({
  useTaskResource: (id: string) => {
    useSyncExternalStore(store.subscribe, store.version, store.version);
    return {
      loaded: Boolean(store.state.loaded[id]),
      data: { task: store.state.tasks[id] ?? { id, status: "running" }, events: [] },
    };
  },
  useTaskList: () => ({ data: [] }),
  usePendingResources: () => ({ data: { approvals: [], questions: [] } }),
}));
vi.mock("../api/client", () => ({
  isTerminal: (status: string) => ["succeeded", "failed", "canceled"].includes(status),
}));
vi.mock("../hooks/useAgentRoles", () => ({ useAgentRoles: () => [] }));
vi.mock("../store/appStore", () => ({ subscribeWS: () => () => {} }));
vi.mock("../components/layout/SessionTabs", () => ({
  default: ({ onClose }: { onClose: (id: string) => void }) => (
    <div>
      tabs
      <button type="button" onClick={() => onClose("a")}>
        close a
      </button>
    </div>
  ),
}));
vi.mock("../components/mobile/SessionSwitcherSheet", () => ({ default: () => null }));
vi.mock("./TaskDetailPage", () => ({
  default: ({ taskId, active }: { taskId: string; active: boolean }) => (
    <div data-testid={`pane-${taskId}`} data-active={String(active)}>
      conversation {taskId}
    </div>
  ),
}));

function GoTo() {
  const navigate = useNavigate();
  return (
    <button type="button" onClick={() => navigate("/tasks/b")}>
      go to b
    </button>
  );
}

function setup(path = "/tasks/a") {
  return render(
    <MemoryRouter initialEntries={[path]}>
      <GoTo />
      <TaskSessionHost />
    </MemoryRouter>,
  );
}

/** The wrapper that hides a pane with `display:none`. */
function paneBox(taskId: string): HTMLElement {
  const pane = screen.getByTestId(`pane-${taskId}`);
  const box = pane.closest("[aria-hidden]");
  if (!(box instanceof HTMLElement)) throw new Error(`pane ${taskId} has no wrapper`);
  return box;
}

beforeEach(() => {
  setLocale("en");
  localStorage.clear();
  store.state.version = 0;
  store.state.loaded = {};
  store.state.tasks = {};
});

describe("switching conversations", () => {
  it("keeps the loaded conversation on screen until the next one arrives", async () => {
    store.state.loaded.a = true;
    setup();

    await waitFor(() => expect(screen.getByTestId("pane-a")).toBeTruthy());
    const shell = paneBox("a").parentElement;
    expect(paneBox("a").getAttribute("aria-hidden")).toBe("false");
    expect(screen.queryByRole("progressbar")).toBeNull();

    await userEvent.click(screen.getByRole("button", { name: "go to b" }));

    // The new pane exists and is loading, but the reader still sees a.
    await waitFor(() => expect(screen.getByTestId("pane-b")).toBeTruthy());
    expect(paneBox("a").getAttribute("aria-hidden")).toBe("false");
    expect(paneBox("a").className).not.toContain("hidden");
    expect(paneBox("b").getAttribute("aria-hidden")).toBe("true");
    expect(paneBox("b").className).toContain("hidden");
    // Thin progress line over the readable conversation, not a page skeleton.
    expect(screen.getByRole("progressbar")).toBeTruthy();
    expect(screen.queryByTestId("pane-b")?.textContent).toBe("conversation b");
    // The keys follow the pane on screen: the outgoing conversation keeps them
    // until the new one has content, and the hidden one owns nothing.
    expect(screen.getByTestId("pane-a").getAttribute("data-active")).toBe("true");
    expect(screen.getByTestId("pane-b").getAttribute("data-active")).toBe("false");
    // The shell that holds both panes is the same node: nothing was remounted.
    expect(paneBox("a").parentElement).toBe(shell);

    await act(async () => {
      store.set("b", true);
    });

    await waitFor(() => expect(paneBox("b").getAttribute("aria-hidden")).toBe("false"));
    expect(paneBox("a").getAttribute("aria-hidden")).toBe("true");
    expect(paneBox("b").className).not.toContain("hidden");
    expect(screen.queryByRole("progressbar")).toBeNull();
    expect(screen.getByTestId("pane-b").getAttribute("data-active")).toBe("true");
    expect(paneBox("a").parentElement).toBe(shell);
  });

  it("does not go blank when the kept pane is closed mid-switch", async () => {
    store.state.loaded.a = true;
    setup();
    await waitFor(() => expect(screen.getByTestId("pane-a")).toBeTruthy());

    await userEvent.click(screen.getByRole("button", { name: "go to b" }));
    await waitFor(() => expect(screen.getByTestId("pane-b")).toBeTruthy());
    expect(paneBox("b").getAttribute("aria-hidden")).toBe("true");

    // Closing the tab of the conversation still on screen while b loads leaves
    // no loaded pane to hold: b must stop being hidden behind it, or the area
    // is blank except for the progress line.
    await userEvent.click(screen.getByRole("button", { name: "close a" }));

    await waitFor(() => expect(screen.queryByTestId("pane-a")).toBeNull());
    expect(paneBox("b").getAttribute("aria-hidden")).toBe("false");
    expect(paneBox("b").className).not.toContain("hidden");
  });

  it("draws no progress line when the first conversation has never loaded", async () => {
    setup();

    await waitFor(() => expect(screen.getByTestId("pane-a")).toBeTruthy());
    expect(screen.queryByRole("progressbar")).toBeNull();
    expect(paneBox("a").getAttribute("aria-hidden")).toBe("false");
  });
});
