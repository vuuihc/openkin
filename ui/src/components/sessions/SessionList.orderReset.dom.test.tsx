// @vitest-environment jsdom
import { beforeEach, describe, expect, it, vi } from "vitest";
import { cleanup, render, screen, waitFor, within } from "@testing-library/react";
import userEvent from "@testing-library/user-event";
import { MemoryRouter } from "react-router-dom";
import SessionList from "./SessionList";
import { setLocale } from "../../i18n";
import type { AgentSession, Project, Task } from "../../api/client";

/**
 * Pinned and No-project are synthetic buckets: their `cwd` is empty, so they
 * have no project record and the project heading's hover strip / actions menu
 * never drew for them. A drag or Alt+↑/↓ inside one still wrote a manual order
 * to `kin_task_order` under `__pinned__` / `__unassigned__`, and once written
 * nothing on screen could take it back: the bucket was stuck in the hand-made
 * order with no way to return to recent activity.
 *
 * The reset is the same control the real project heading already offers, so
 * these tests pin the synthetic bucket to it and leave the project bucket's
 * own hover strip alone.
 *
 * RSI item R-pinned-order-reset, escaped from KIN-MANAGE-001's manual order.
 */

const fixtures = vi.hoisted(() => ({
  tasks: [] as Task[],
}));

vi.mock("../../api/useLiveResources", () => ({
  useTaskList: () => ({
    data: fixtures.tasks,
    loaded: true,
    error: null,
    pageFull: false,
    loading: false,
  }),
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
    listAgentSessionsPage: vi.fn(async () => ({
      items: [] as AgentSession[],
      next_cursor: undefined,
    })),
    listTasks: vi.fn(async () => []),
    listProjects: vi.fn(async () => [] as Project[]),
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
}));

/**
 * KIN-CONTINUE-007 opens only the newest real project; the synthetic pinned
 * bucket is a heading until someone opens it.
 */
async function openPinned(): Promise<void> {
  await userEvent.click(await screen.findByRole("button", { name: "Expand project Pinned" }));
}

function viewport(pointer: "fine" | "coarse") {
  vi.stubGlobal("matchMedia", (query: string) => ({
    matches: query === "(pointer: coarse)" ? pointer === "coarse" : false,
    media: query,
    onchange: null,
    addEventListener: vi.fn(),
    removeEventListener: vi.fn(),
    addListener: vi.fn(),
    removeListener: vi.fn(),
    dispatchEvent: vi.fn(),
  }));
}

function task(id: string, cwd: string, createdAt: number): Task {
  return {
    id,
    title: id,
    cwd,
    agent: "kin",
    prompt: "",
    status: "succeeded",
    tokens_in: 0,
    tokens_out: 0,
    event_epoch: 0,
    created_at: createdAt,
  } as Task;
}

function mount() {
  return render(
    <MemoryRouter initialEntries={["/sessions"]}>
      <SessionList shell="sidebar" />
    </MemoryRouter>,
  );
}

/** The rows in the order the reader sees them. */
function order(): string[] {
  return Array.from(document.querySelectorAll<HTMLElement>("[data-session-row]")).map(
    (el) => el.dataset.sessionRow ?? "",
  );
}

/** The reset control inside the section whose heading names `heading`. */
function resetIn(heading: string): HTMLElement {
  const section = screen.getByRole("button", { name: heading }).closest("section");
  if (!section) throw new Error(`the ${heading} heading is not inside a section`);
  return within(section as HTMLElement).getByRole("button", { name: /restore time order/i });
}

beforeEach(() => {
  setLocale("en");
  localStorage.clear();
  sessionStorage.clear();
  fixtures.tasks = [];
  viewport("fine");
});

describe("restoring time order in a synthetic bucket", () => {
  it("offers the pinned bucket its own restore-time-order control", async () => {
    const user = userEvent.setup();
    fixtures.tasks = [task("p-low", "/work/alpha", 100), task("p-high", "/work/alpha", 200)];
    localStorage.setItem("kin_pinned_tasks", JSON.stringify(["p-low", "p-high"]));
    // The hand-made order is the reverse of the clock's.
    localStorage.setItem("kin_task_order", JSON.stringify({ __pinned__: ["p-low", "p-high"] }));
    mount();
    await openPinned();
    await waitFor(() => expect(order()).toEqual(["p-low", "p-high"]));

    await user.click(resetIn("Pinned"));

    await waitFor(() => expect(order()).toEqual(["p-high", "p-low"]));
    const stored = JSON.parse(localStorage.getItem("kin_task_order") ?? "{}") as Record<
      string,
      string[]
    >;
    expect(stored.__pinned__).toBeUndefined();
    expect(screen.queryByRole("button", { name: /restore time order/i })).toBeNull();
  });

  it("offers the unassigned bucket the same reset", async () => {
    const user = userEvent.setup();
    fixtures.tasks = [task("loose-low", "", 100), task("loose-high", "", 200)];
    localStorage.setItem(
      "kin_task_order",
      JSON.stringify({ __unassigned__: ["loose-low", "loose-high"] }),
    );
    mount();
    await waitFor(() => expect(order()).toEqual(["loose-low", "loose-high"]));

    await user.click(resetIn("No project"));

    await waitFor(() => expect(order()).toEqual(["loose-high", "loose-low"]));
    const stored = JSON.parse(localStorage.getItem("kin_task_order") ?? "{}") as Record<
      string,
      string[]
    >;
    expect(stored.__unassigned__).toBeUndefined();
    expect(screen.queryByRole("button", { name: /restore time order/i })).toBeNull();
  });

  it("does not offer a reset when the bucket has no stored order", async () => {
    fixtures.tasks = [task("pinned-1", "/work/alpha", 100), task("loose-1", "", 200)];
    localStorage.setItem("kin_pinned_tasks", JSON.stringify(["pinned-1"]));
    mount();
    // Only the newest bucket opens by default (KIN-CONTINUE-007); open the
    // synthetic Pinned bucket, which folds the other one.
    await openPinned();
    await waitFor(() => expect(order()).toEqual(["pinned-1"]));

    expect(screen.queryByRole("button", { name: /restore time order/i })).toBeNull();
  });

  it("gives the fine-pointer reset the same name and 24px shape as a project's", async () => {
    fixtures.tasks = [task("p-low", "/work/alpha", 100), task("p-high", "/work/alpha", 200)];
    localStorage.setItem("kin_pinned_tasks", JSON.stringify(["p-low", "p-high"]));
    localStorage.setItem("kin_task_order", JSON.stringify({ __pinned__: ["p-low", "p-high"] }));
    mount();
    await openPinned();
    await waitFor(() => expect(order()).toEqual(["p-low", "p-high"]));

    const button = resetIn("Pinned");
    // The hover strip's project icon explains itself with a tooltip; a bare
    // circular arrow next to "Pinned" would otherwise read as "refresh".
    expect(button.getAttribute("title")).toBe("Restore time order");
    expect(button.getAttribute("aria-label")).toBe("Restore time order");
    expect(button.className.split(/\s+/)).toEqual(expect.arrayContaining(["h-6", "w-6"]));
  });

  it("returns focus to the bucket heading after a keyboard reset", async () => {
    const user = userEvent.setup();
    fixtures.tasks = [task("p-low", "/work/alpha", 100), task("p-high", "/work/alpha", 200)];
    localStorage.setItem("kin_pinned_tasks", JSON.stringify(["p-low", "p-high"]));
    localStorage.setItem("kin_task_order", JSON.stringify({ __pinned__: ["p-low", "p-high"] }));
    mount();
    await openPinned();
    await waitFor(() => expect(order()).toEqual(["p-low", "p-high"]));

    resetIn("Pinned").focus();
    await user.keyboard("{Enter}");

    // The reset control unmounts with the order it clears; the heading takes
    // focus back instead of it dropping to <body>.
    await waitFor(() =>
      expect(document.activeElement).toBe(screen.getByRole("button", { name: "Pinned" })),
    );
    expect(order()).toEqual(["p-high", "p-low"]);
  });

  it("keeps the project bucket reset and labels the synthetic one on coarse pointers", async () => {
    // A real project heading keeps its own hover-strip reset: that path must
    // not regress when the synthetic buckets gain a heading control.
    fixtures.tasks = [task("alpha-1", "/work/alpha", 100)];
    localStorage.setItem("kin_task_order", JSON.stringify({ "/work/alpha": ["alpha-1"] }));
    mount();
    await waitFor(() => expect(order()).toEqual(["alpha-1"]));
    resetIn("alpha");

    // The phone has no hover strip and no tooltip, so the synthetic bucket's
    // control is the only way out there, has to meet the touch floor itself,
    // and says what it does instead of showing a mystery ↻.
    cleanup();
    localStorage.clear();
    viewport("coarse");
    fixtures.tasks = [task("p-low", "/work/alpha", 100), task("p-high", "/work/alpha", 200)];
    localStorage.setItem("kin_pinned_tasks", JSON.stringify(["p-low", "p-high"]));
    localStorage.setItem("kin_task_order", JSON.stringify({ __pinned__: ["p-low", "p-high"] }));
    mount();
    await openPinned();
    await waitFor(() => expect(order()).toEqual(["p-low", "p-high"]));

    const button = resetIn("Pinned");
    expect(button.getAttribute("aria-label")).toBe("Restore time order");
    expect(button.textContent).toContain("Restore");
    // Astryx renders children inside a non-flex label span, and Tailwind makes
    // the block <svg> stack above the text; icon and label share one row only
    // inside an explicit inline-flex wrapper.
    const label = button.querySelector("span.inline-flex");
    expect(label?.querySelector("svg")).not.toBeNull();
    expect(label?.textContent).toBe("Restore");
    // Token-level: `h-11` must be its own class, not a suffix of `min-h-11`.
    expect(button.className.split(/\s+/)).toContain("h-11");
  });
});
