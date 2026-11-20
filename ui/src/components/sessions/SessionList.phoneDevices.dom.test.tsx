// @vitest-environment jsdom
import { beforeEach, describe, expect, it, vi } from "vitest";
import { render, screen, waitFor, within } from "@testing-library/react";
import userEvent from "@testing-library/user-event";
import { MemoryRouter, useLocation } from "react-router-dom";
import SessionList from "./SessionList";
import SessionsHeader from "../mobile/SessionsHeader";
import { setLocale } from "../../i18n";
import type { Machine } from "../../lib/devices";
import type { AgentSession, Project, Task } from "../../api/client";

/**
 * KIN-CONTINUE-004: every machine heading on the phone list is a place work can
 * start, not only a label.
 *
 * The draft machine is stored separately from the cwd, so the action has to set
 * both before it opens the composer: a remote path with no machine recorded
 * would quietly become a local path in the draft. A machine that is offline is
 * still shown (its history is readable) but its action is disabled with the
 * reason in reachable text.
 */

const fixtures = vi.hoisted(() => ({
  tasks: [] as Task[],
  projects: [] as Project[],
  machines: [] as Machine[],
  failed: false,
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
    listProjects: vi.fn(async () => fixtures.projects),
    listTasks: vi.fn(async () => []),
    ensureProject: vi.fn(async () => ({ id: "p", name: "shared" })),
  };
});

vi.mock("../../hooks/useMachines", () => ({
  useMachines: () => ({
    machines: fixtures.machines,
    loading: false,
    failed: fixtures.failed,
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

function task(id: string, cwd: string, device?: string): Task {
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
    ...(device ? { executing_device_id: device } : {}),
  } as Task;
}

function machine(id: string, label: string, isSelf = false, online = true): Machine {
  return { id, label, isSelf, online, roots: [], agents: [] };
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
  fixtures.tasks = [task("local-work", "/work/alpha"), task("remote-work", "/srv/beta", "nas-1")];
  fixtures.projects = [];
  fixtures.failed = false;
  fixtures.machines = [machine("mac-1", "MacBook", true), machine("nas-1", "Studio")];
  viewport();
});

describe("a machine heading on the phone list", () => {
  it("shows a new-chat action beside every device heading", () => {
    page();

    expect(screen.getByRole("button", { name: "New chat on This machine" })).toBeTruthy();
    expect(screen.getByRole("button", { name: "New chat on Studio" })).toBeTruthy();
  });

  it("aims the draft at the device before opening the composer", async () => {
    page();

    await userEvent.click(screen.getByRole("button", { name: "New chat on Studio" }));

    // The machine and its directory travel together; the group's most recent
    // conversation names the directory.
    expect(localStorage.getItem("kin_draft_machine")).toBe("nas-1");
    expect(localStorage.getItem("kin_draft_cwd")).toBe("/srv/beta");
    expect(locationText()).toBe("/new");
  });

  it("disables new on an offline device and says why", async () => {
    fixtures.machines = [
      machine("mac-1", "MacBook", true),
      machine("nas-1", "Studio", false, false),
    ];
    page();

    const button = screen.getByRole("button", { name: "New chat on Studio" });
    expect(button.getAttribute("aria-disabled")).toBe("true");
    const reason = screen.getByText(/Offline — connect this machine/);
    expect(button.getAttribute("aria-describedby")).toBe(reason.id);

    await userEvent.click(button);
    expect(locationText()).toBe("/sessions");
    expect(localStorage.getItem("kin_draft_machine")).toBeNull();
  });

  it("shows a device with no conversations without a fake project row", () => {
    fixtures.machines = [machine("mac-1", "MacBook", true), machine("attic-1", "Attic Mac")];
    page();

    const attic = screen.getByRole("region", { name: "Attic Mac" });
    expect(within(attic).getByText("No chats on this machine yet")).toBeTruthy();
    const actions = within(attic).getAllByRole("button");
    // The heading's new-chat action is the only control: no fold arrow and no
    // invented project row.
    expect(actions).toHaveLength(1);
    expect(actions[0]!.getAttribute("aria-label")).toBe("New chat on Attic Mac");
  });

  it("returns focus to the device action after the draft closes", async () => {
    const first = page();
    await userEvent.click(screen.getByRole("button", { name: "New chat on Studio" }));
    first.unmount();

    // Closing the draft remounts the list; focus goes back to the control the
    // reader used, not to the top of the page.
    page();
    await waitFor(() =>
      expect(document.activeElement?.getAttribute("aria-label")).toBe("New chat on Studio"),
    );
  });

  it("keeps the header new-chat action", () => {
    page();

    // The default entry does not depend on a device heading existing, so it
    // stays beside the title (KIN-CONTINUE-002) and keeps its plain name.
    expect(screen.getByRole("button", { name: "New chat" })).toBeTruthy();
  });
});
