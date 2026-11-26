// @vitest-environment jsdom
import { beforeEach, describe, expect, it, vi } from "vitest";
import { render, screen } from "@testing-library/react";
import userEvent from "@testing-library/user-event";
import { MemoryRouter, useLocation } from "react-router-dom";
import SessionList from "./SessionList";
import SessionsHeader from "../mobile/SessionsHeader";
import { setLocale } from "../../i18n";
import type { Machine } from "../../lib/devices";
import { forgetPlaceReturn } from "../../lib/placeReturn";
import type { AgentSession, Project, Task } from "../../api/client";

/**
 * R-phone-heading-yield: a project heading is a row too.
 *
 * The floating 等待处理 strip yields to a conversation row because the row
 * carries `data-session-row`. The project / imported-group heading is in the
 * same list and is just as tappable, but it carried no marker, so the strip
 * covered it and a real touch on its centre opened the waiting conversation
 * instead of folding the group. The heading now carries the shared, unscoped
 * `data-kin-hit-row` marker; it must not carry `data-session-row`, which means
 * "a conversation row" to the drag and row-count code.
 *
 * jsdom cannot hit-test, so these tests pin the marker on the real headings
 * and the fold behaviour the dogfood measured. The strip's decision is pinned
 * in `FloatingApproval.headingYield.dom.test.tsx`.
 */

const fixtures = vi.hoisted(() => ({
  tasks: [] as Task[],
  projects: [] as Project[],
  machines: [] as Machine[],
  sessions: [] as AgentSession[],
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
    isAuthenticated: () => true,
    listAgentSessionsPage: vi.fn(async () => ({
      items: fixtures.sessions,
      next_cursor: undefined,
    })),
    listProjects: vi.fn(async () => fixtures.projects),
    listTasks: vi.fn(async () => []),
    ensureProject: vi.fn(async () => ({ id: "p", name: "alpha" })),
  };
});

vi.mock("../../hooks/useMachines", () => ({
  useMachines: () => ({
    machines: fixtures.machines,
    loading: false,
    failed: false,
  }),
}));

function viewport() {
  vi.stubGlobal("matchMedia", (query: string) => ({
    matches: query === "(pointer: coarse)",
    media: query,
    onchange: null,
    addEventListener: vi.fn(),
    removeEventListener: vi.fn(),
    addListener: vi.fn(),
    removeListener: vi.fn(),
    dispatchEvent: vi.fn(),
  }));
}

function task(id: string, cwd: string): Task {
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
    created_at: 1,
  } as Task;
}

function project(id: string, name: string, root: string): Project {
  return {
    id,
    name,
    mode: "default",
    status: "active",
    created_at: 1,
    updated_at: 1,
    last_active_at: 1,
    roots: [root],
  } as Project;
}

function machine(id: string, label: string, isSelf = false): Machine {
  return { id, label, isSelf, online: true, roots: [], agents: [] };
}

function session(id: string): AgentSession {
  return {
    id,
    agent_id: "codex",
    external_ref: id,
    title: `Imported chat ${id}`,
    cwd: "/work/alpha",
    status: "idle",
    first_seen_at: 0,
    last_seen_at: 0,
    updated_at: 1,
    linked: false,
    capabilities: ["session_attach"],
  } as AgentSession;
}

/** The list owns the URL, so a probe reads what it wrote. */
function LocationProbe() {
  const location = useLocation();
  return <output data-testid="location">{location.pathname}</output>;
}

function page() {
  return render(
    <MemoryRouter initialEntries={["/sessions"]}>
      <LocationProbe />
      <SessionsHeader />
      <SessionList shell="page" />
    </MemoryRouter>,
  );
}

function locationText(): string {
  return screen.getByTestId("location").textContent ?? "";
}

beforeEach(() => {
  setLocale("en");
  localStorage.clear();
  sessionStorage.clear();
  forgetPlaceReturn();
  fixtures.tasks = [task("alpha-work", "/work/alpha")];
  fixtures.projects = [project("p-alpha", "Project Alpha", "/work/alpha")];
  fixtures.machines = [machine("mac-1", "MacBook", true)];
  fixtures.sessions = [session("imported-1")];
  viewport();
});

describe("a project heading on the phone list", () => {
  it("R-phone-heading-yield: every project and imported-group heading marks itself as a row the floating surface must not cover", async () => {
    page();

    const projectHeading = await screen.findByRole("button", { name: "Project Alpha" });
    expect(projectHeading.getAttribute("data-kin-hit-row")).toBe("");

    const importedHeading = await screen.findByRole("button", { name: "Imported sessions (1)" });
    expect(importedHeading.getAttribute("data-kin-hit-row")).toBe("");

    // The heading is not a conversation row: `data-session-row` is what the
    // drag index and the row counts read, and a heading carrying it would
    // corrupt both. The conversation row keeps its own marker.
    expect(projectHeading.hasAttribute("data-session-row")).toBe(false);
    expect(importedHeading.hasAttribute("data-session-row")).toBe(false);
    expect(document.querySelector("[data-session-row]")).not.toBeNull();
  });

  it("R-phone-heading-yield: tapping the imported group heading folds and unfolds it in place", async () => {
    page();

    // Imported groups are folded until asked for. The heading's own tap has to
    // reach it — the strip used to eat that tap and open the waiting task.
    const heading = await screen.findByRole("button", { name: "Imported sessions (1)" });
    expect(heading.getAttribute("aria-expanded")).toBe("false");

    await userEvent.click(heading);
    expect(
      screen.getByRole("button", { name: "Imported sessions (1)" }).getAttribute("aria-expanded"),
    ).toBe("true");
    expect(locationText()).toBe("/sessions");

    await userEvent.click(screen.getByRole("button", { name: "Imported sessions (1)" }));
    expect(
      screen.getByRole("button", { name: "Imported sessions (1)" }).getAttribute("aria-expanded"),
    ).toBe("false");
    expect(locationText()).toBe("/sessions");
  });
});
