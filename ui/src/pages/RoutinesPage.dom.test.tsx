// @vitest-environment jsdom
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { fireEvent, render, screen, waitFor, within } from "@testing-library/react";
import userEvent from "@testing-library/user-event";
import { MemoryRouter } from "react-router-dom";
import type { MachineInfo, Routine, Task } from "../api/client";
import { setLocale } from "../i18n";
import { resetMachinesCache } from "../hooks/useMachines";
import { useAppStore } from "../store/appStore";

/**
 * KIN-ROUTINE-001: the routines page is one machine's inbox.
 *
 * It opens on the machine the reader last chose (even when that machine is
 * offline), shows the run records without ever embedding a conversation, and
 * asks where a run's session starts. The default is the signed one: continue the
 * same session; starting over each run is a choice.
 */

const client = vi.hoisted(() => ({
  listRoutines: vi.fn(),
  listRoutineRuns: vi.fn(),
  listTasks: vi.fn(),
  createRoutine: vi.fn(),
  patchRoutine: vi.fn(),
  deleteRoutine: vi.fn(),
  runRoutineNow: vi.fn(),
  markRoutineRunRead: vi.fn(),
  markAllRoutineRunsRead: vi.fn(),
  listMachines: vi.fn(),
  serverVersion: vi.fn(),
  listAgents: vi.fn(),
  previewRoutine: vi.fn(),
}));

vi.mock("../api/client", async (importOriginal) => {
  const actual = await importOriginal<typeof import("../api/client")>();
  return {
    ...actual,
    isAuthenticated: () => true,
    listRoutines: client.listRoutines,
    listRoutineRuns: client.listRoutineRuns,
    listTasks: client.listTasks,
    createRoutine: client.createRoutine,
    patchRoutine: client.patchRoutine,
    deleteRoutine: client.deleteRoutine,
    runRoutineNow: client.runRoutineNow,
    markRoutineRunRead: client.markRoutineRunRead,
    markAllRoutineRunsRead: client.markAllRoutineRunsRead,
    listMachines: client.listMachines,
    serverVersion: client.serverVersion,
    listAgents: client.listAgents,
    previewRoutine: client.previewRoutine,
  };
});

// The directory control is a page of its own; here it only has to hand a path
// to the form.
vi.mock("../components/chat/CwdPicker", () => ({
  default: ({
    cwd,
    onChange,
    locked,
  }: {
    cwd: string;
    onChange: (next: string) => void;
    locked?: boolean;
  }) => (
    <input
      aria-label="Working directory"
      value={cwd}
      disabled={locked}
      onChange={(e) => onChange(e.target.value)}
    />
  ),
}));

import RoutinesPage from "./RoutinesPage";

function routine(over: Partial<Routine> = {}): Routine {
  return {
    id: "routine-1",
    cwd: "/work/alpha",
    agent: "claude-code",
    permission_mode: "default",
    prompt: "tidy the notes",
    interval_secs: 86400,
    enabled: true,
    next_due_at: Date.now() + 3600_000,
    consec_failures: 0,
    created_at: Date.now() - 10_000,
    title: "Daily notes",
    missed_run_policy: "coalesce",
    lane: "routine",
    conversation_mode: "continue",
    ...over,
  };
}

function run(over: Partial<Task> = {}): Task {
  return {
    id: "run-1",
    title: "run",
    agent: "claude-code",
    cwd: "/work/alpha",
    prompt: "go",
    status: "succeeded",
    created_at: Date.now() - 5000,
    ...over,
  } as Task;
}

function machineInfo(
  id: string,
  label: string,
  reachability: "online" | "offline",
): MachineInfo {
  return { id, label, reachability, agents: [] };
}

const LAPTOP = machineInfo("device-laptop", "Laptop", "online");
const STUDIO = machineInfo("device-studio", "Studio", "offline");

function renderPage() {
  return render(
    <MemoryRouter initialEntries={["/routines"]}>
      <RoutinesPage />
    </MemoryRouter>,
  );
}

/** Open the create form and wait for its focus move to land.
 *
 *  Opening moves focus to the title on the next frame. A test that starts
 *  filling sooner sends its first characters to the title, and the form then
 *  stays disabled for a reason the test never intended to exercise. */
async function openCreateForm(user: ReturnType<typeof userEvent.setup>) {
  await user.click(await screen.findByRole("button", { name: "New routine" }));
  await waitFor(() =>
    expect(document.activeElement).toBe(screen.getByPlaceholderText("Morning PR review")),
  );
}

/** Fill a field in one input event; typing 11 keys one at a time is what
 *  made this suite flicker under load, and the tests are not about typing. */
async function paste(user: ReturnType<typeof userEvent.setup>, field: HTMLElement, value: string) {
  await user.click(field);
  await user.paste(value);
}

/** A submit control is only actionable once the form's own gate opened. */
async function enabledSubmit(name: string): Promise<HTMLButtonElement> {
  await waitFor(() => {
    const button = screen.getByRole("button", { name }) as HTMLButtonElement;
    expect(button.disabled, JSON.stringify({
      prompt: (screen.getByPlaceholderText(/Review new PRs/i) as HTMLTextAreaElement).value,
      cwd: (screen.getByLabelText("Working directory") as HTMLInputElement).value,
    })).toBe(false);
  });
  return screen.getByRole("button", { name }) as HTMLButtonElement;
}

beforeEach(() => {
  setLocale("en");
  localStorage.clear();
  resetMachinesCache();
  vi.spyOn(window.history, "back").mockImplementation(() => {});
  // Closing a form is a decision; tests choose for the reader.
  vi.spyOn(window, "confirm").mockReturnValue(true);
  useAppStore.setState({ wsStatus: "connected", reconnectGen: 0, toasts: [] });
  for (const fn of Object.values(client)) fn.mockReset();
  client.serverVersion.mockResolvedValue({ desktop_id: "desktop-self", desktop_name: "This Mac" });
  client.listMachines.mockResolvedValue([LAPTOP, STUDIO]);
  client.listAgents.mockResolvedValue([]);
  client.listRoutines.mockResolvedValue({ routines: [], has_more: false, next_cursor: "" });
  client.listRoutineRuns.mockResolvedValue([]);
  client.listTasks.mockResolvedValue([]);
  client.previewRoutine.mockResolvedValue({ next_due_at: Date.now() + 3600_000 });
});

afterEach(() => {
  vi.restoreAllMocks();
  resetMachinesCache();
});

describe("the routines console (KIN-ROUTINE-001)", () => {
  it("keeps a remembered offline machine and says writes are disabled", async () => {
    localStorage.setItem("kin_routines_device", "device-studio");
    renderPage();

    // The machine stays the one the reader chose; the page does not quietly
    // move to the online laptop beside it.
    expect(await screen.findByText(/Studio · offline/)).toBeTruthy();
    expect((await screen.findByRole("status")).textContent).toContain("offline");
    await waitFor(() => expect(client.listRoutines).toHaveBeenCalled());
    expect(client.listRoutines.mock.calls.at(-1)?.[1]).toBe("device-studio");

    // New routine and Run now are the two writes the banner promises are off.
    const newRoutine = screen.getAllByRole("button", { name: "New routine" });
    expect(newRoutine.length).toBeGreaterThan(0);
    for (const button of newRoutine) {
      expect((button as HTMLButtonElement).disabled).toBe(true);
    }
  });

  it("opens an empty machine with its own words and a way to start", async () => {
    localStorage.setItem("kin_routines_device", "self");
    renderPage();
    expect(
      await screen.findByText("No routines configured. Open a project and add one."),
    ).toBeTruthy();
    expect(screen.getAllByRole("button", { name: "New routine" }).length).toBeGreaterThan(0);
  });

  it("defaults a new routine to continuing the same session", async () => {
    localStorage.setItem("kin_routines_device", "self");
    const user = userEvent.setup();
    renderPage();
    await openCreateForm(user);

    expect(
      (screen.getByRole("radio", { name: "Continue the same session" }) as HTMLInputElement)
        .checked,
    ).toBe(true);
    expect(
      (screen.getByRole("radio", { name: "Start a new session each run" }) as HTMLInputElement)
        .checked,
    ).toBe(false);
    expect(screen.getByText(/first run starts a session/i)).toBeTruthy();
  });

  it("explains the fresh choice in the routine's directory", async () => {
    localStorage.setItem("kin_routines_device", "self");
    const user = userEvent.setup();
    renderPage();
    await openCreateForm(user);
    await user.click(screen.getByRole("radio", { name: "Start a new session each run" }));
    expect(screen.getByText(/Every run starts a new session in this directory/i)).toBeTruthy();
  });

  it("creates a routine with the conversation mode the reader chose", async () => {
    localStorage.setItem("kin_routines_device", "self");
    const user = userEvent.setup();
    client.createRoutine.mockResolvedValue(routine({ conversation_mode: "fresh" }));
    renderPage();
    await openCreateForm(user);

    await paste(user, screen.getByPlaceholderText("Morning PR review"), "Nightly notes");
    await paste(user, screen.getByPlaceholderText(/Review new PRs/i), "tidy the notes");
    await paste(user, screen.getByLabelText("Working directory"), "/work/alpha");
    await user.click(screen.getByRole("radio", { name: "Start a new session each run" }));
    await user.click(await enabledSubmit("Create routine"));

    await waitFor(() => expect(client.createRoutine).toHaveBeenCalledTimes(1));
    const body = client.createRoutine.mock.calls[0][0];
    expect(body).toMatchObject({
      title: "Nightly notes",
      cwd: "/work/alpha",
      prompt: "tidy the notes",
      conversation_mode: "fresh",
    });
    expect(client.createRoutine.mock.calls[0][1]).toBe("self");
  });

  it("sends only the conversation mode when that is all an edit changes", async () => {
    localStorage.setItem("kin_routines_device", "self");
    const user = userEvent.setup();
    client.listRoutines.mockResolvedValue({
      routines: [routine()],
      has_more: false,
      next_cursor: "",
    });
    client.listRoutineRuns.mockResolvedValue([run({ routine_id: "routine-1" })]);
    client.listTasks.mockResolvedValue([run({ routine_id: "routine-1" })]);
    client.patchRoutine.mockResolvedValue(routine({ conversation_mode: "fresh" }));
    renderPage();

    await user.click(await screen.findByRole("button", { name: "Edit Daily notes" }));
    await user.click(screen.getByRole("radio", { name: "Start a new session each run" }));
    await user.click(screen.getByRole("button", { name: "Save changes" }));

    await waitFor(() => expect(client.patchRoutine).toHaveBeenCalledTimes(1));
    expect(client.patchRoutine.mock.calls[0][1]).toEqual({ conversation_mode: "fresh" });
  });

  it("shows run records without embedding the conversation", async () => {
    localStorage.setItem("kin_routines_device", "self");
    const user = userEvent.setup();
    client.listRoutines.mockResolvedValue({
      routines: [routine()],
      has_more: false,
      next_cursor: "",
    });
    client.listRoutineRuns.mockResolvedValue([
      run({
        id: "run-1",
        routine_id: "routine-1",
        title: "Yesterday's run",
        prompt: "SECRET-TRANSCRIPT",
        routine_tldr: "three notes tidied",
      }),
    ]);
    client.listTasks.mockResolvedValue([
      run({
        id: "run-1",
        routine_id: "routine-1",
        title: "Yesterday's run",
        prompt: "SECRET-TRANSCRIPT",
        routine_tldr: "three notes tidied",
      }),
    ]);
    renderPage();

    await user.click(
      await screen.findByRole("button", { name: "Show the run records for Daily notes" }),
    );
    // The panel is rendered once for the phone (inline) and once for the
    // desktop (aside); each copy shows the same record.
    const panel = (await screen.findAllByRole("region", { name: /Run history/ }))[0];
    expect(within(panel).getByText("Yesterday's run")).toBeTruthy();
    expect(within(panel).getByText("three notes tidied")).toBeTruthy();
    expect(within(panel).getByRole("link", { name: /Open conversation/ })).toBeTruthy();
    // The record names the conversation; it does not render what was said in it.
    expect(screen.queryByText(/SECRET-TRANSCRIPT/)).toBeNull();
    expect(within(panel).getByText(/Times and results only/i)).toBeTruthy();
  });

  it("appends an older page without repeating the runs already shown", async () => {
    localStorage.setItem("kin_routines_device", "self");
    const user = userEvent.setup();
    client.listRoutines.mockResolvedValue({
      routines: [routine()],
      has_more: false,
      next_cursor: "",
    });
    const firstPage = Array.from({ length: 10 }, (_, i) =>
      run({
        id: `run-${20 - i}`,
        routine_id: "routine-1",
        title: `Run ${20 - i}`,
      }),
    );
    const olderPage = [
      run({ id: "run-11", routine_id: "routine-1", title: "Run 11" }),
      ...Array.from({ length: 10 }, (_, i) =>
        run({
          id: `run-${10 - i}`,
          routine_id: "routine-1",
          title: `Run ${10 - i}`,
        }),
      ),
    ];
    client.listTasks.mockResolvedValueOnce(firstPage).mockResolvedValueOnce(olderPage);
    client.listRoutineRuns.mockResolvedValue(firstPage);
    renderPage();

    await user.click(
      await screen.findByRole("button", { name: "Show the run records for Daily notes" }),
    );
    const panel = (await screen.findAllByRole("region", { name: /Run history/ }))[0];
    await user.click(within(panel).getByRole("button", { name: "Load older runs" }));
    expect(await within(panel).findByText("Run 1")).toBeTruthy();
    // "Run 11" straddled the cursor; it is one record, not two.
    expect(within(panel).getAllByText("Run 11").length).toBe(1);
    expect(client.listTasks.mock.calls.at(-1)?.[0]).toMatchObject({
      routineId: "routine-1",
      limit: 10,
    });
  });

  it("counts unread runs per routine and clears them with Mark all read", async () => {
    localStorage.setItem("kin_routines_device", "self");
    const user = userEvent.setup();
    client.listRoutines.mockResolvedValue({
      routines: [routine()],
      has_more: false,
      next_cursor: "",
    });
    const unread = run({
      id: "run-1",
      routine_id: "routine-1",
      routine_unread: true,
      title: "Unread run",
    });
    client.listRoutineRuns.mockResolvedValue([unread]);
    client.listTasks.mockResolvedValue([unread]);
    client.markAllRoutineRunsRead.mockResolvedValue(undefined);
    renderPage();

    expect(await screen.findByText("1 unread")).toBeTruthy();
    await user.click(screen.getByRole("button", { name: "Mark all read" }));
    await waitFor(() => expect(client.markAllRoutineRunsRead).toHaveBeenCalledWith("self"));
    await waitFor(() => expect(screen.queryByText("1 unread")).toBeNull());
  });

  it("shows the reason a machine could not be read and retries it", async () => {
    localStorage.setItem("kin_routines_device", "self");
    const user = userEvent.setup();
    client.listRoutines
      .mockRejectedValueOnce(new Error("machine is waking up"))
      .mockResolvedValue({ routines: [routine()], has_more: false, next_cursor: "" });
    renderPage();

    expect(await screen.findByText("machine is waking up")).toBeTruthy();
    await user.click(screen.getByRole("button", { name: "Retry" }));
    expect(await screen.findByText("Daily notes")).toBeTruthy();
  });

  it("does not close the form while its save is in flight", async () => {
    localStorage.setItem("kin_routines_device", "self");
    const user = userEvent.setup();
    // The relay has not answered yet; the form must not accept a close that
    // the completion would then apply to whatever form came next.
    client.createRoutine.mockReturnValue(new Promise(() => {}));
    renderPage();
    await openCreateForm(user);
    await paste(user, screen.getByPlaceholderText(/Review new PRs/i), "tidy the notes");
    await paste(user, screen.getByLabelText("Working directory"), "/work/alpha");
    await user.click(await enabledSubmit("Create routine"));
    await waitFor(() => expect(client.createRoutine).toHaveBeenCalledTimes(1));

    const form = screen.getByRole("region", { name: "Create a routine" });
    expect((within(form).getByRole("button", { name: "Cancel" }) as HTMLButtonElement).disabled).toBe(
      true,
    );
    // Every control inside the form is disabled while saving, so focus cannot
    // sit on one; dispatch the key on the form itself, where the handler lives.
    fireEvent.keyDown(form, { key: "Escape" });
    expect(screen.getByPlaceholderText(/Review new PRs/i)).toBeTruthy();
  });

  it("does not discard a typed routine without asking", async () => {
    localStorage.setItem("kin_routines_device", "self");
    const user = userEvent.setup();
    renderPage();
    await openCreateForm(user);
    await paste(user, screen.getByPlaceholderText(/Review new PRs/i), "half-written plan");

    const confirm = vi.mocked(window.confirm).mockReturnValueOnce(false);
    await user.keyboard("{Escape}");
    expect(confirm).toHaveBeenCalled();
    expect(screen.getByPlaceholderText(/Review new PRs/i)).toBeTruthy();

    vi.mocked(window.confirm).mockReturnValueOnce(true);
    await user.keyboard("{Escape}");
    await waitFor(() =>
      expect(screen.queryByPlaceholderText(/Review new PRs/i)).toBeNull(),
    );
  });

  it("saves from the keyboard when the visible Save would be enabled", async () => {
    localStorage.setItem("kin_routines_device", "self");
    const user = userEvent.setup();
    client.createRoutine.mockResolvedValue(routine());
    renderPage();
    await openCreateForm(user);
    await paste(user, screen.getByPlaceholderText(/Review new PRs/i), "tidy the notes");
    await paste(user, screen.getByLabelText("Working directory"), "/work/alpha");

    // The focus is in the directory field; Meta+Enter bubbles to the form.
    await enabledSubmit("Create routine");
    await user.keyboard("{Meta>}{Enter}{/Meta}");
    await waitFor(() => expect(client.createRoutine).toHaveBeenCalledTimes(1), {
      timeout: 3000,
    });
  });

  it("explains that the edited routine's next run continues its last session", async () => {
    localStorage.setItem("kin_routines_device", "self");
    const user = userEvent.setup();
    client.listRoutines.mockResolvedValue({
      routines: [routine({ model: "m1" })],
      has_more: false,
      next_cursor: "",
    });
    const last = run({
      id: "run-1",
      routine_id: "routine-1",
      model: "m1",
      session_ref: "sess-1",
    });
    // The global feed is empty: only the routine's own loaded history knows
    // the last run, which is what the daemon reads.
    client.listRoutineRuns.mockResolvedValue([]);
    client.listTasks.mockResolvedValue([last]);
    renderPage();

    await user.click(await screen.findByRole("button", { name: "Edit Daily notes" }));
    expect(await screen.findByText(/next run continues the session/i)).toBeTruthy();
  });

  it("stops promising the old session as soon as the edit changes the directory", async () => {
    localStorage.setItem("kin_routines_device", "self");
    const user = userEvent.setup();
    client.listRoutines.mockResolvedValue({
      routines: [routine({ model: "m1" })],
      has_more: false,
      next_cursor: "",
    });
    const last = run({
      id: "run-1",
      routine_id: "routine-1",
      model: "m1",
      session_ref: "sess-1",
    });
    client.listRoutineRuns.mockResolvedValue([]);
    client.listTasks.mockResolvedValue([last]);
    renderPage();

    await user.click(await screen.findByRole("button", { name: "Edit Daily notes" }));
    expect(await screen.findByText(/next run continues the session/i)).toBeTruthy();

    // The hint follows what the form would save, because that is what the
    // daemon compares the newest run against after the save.
    const cwd = screen.getByLabelText("Working directory");
    await user.clear(cwd);
    await paste(user, cwd, "/work/beta");
    expect(await screen.findByText(/last run cannot be continued/i)).toBeTruthy();
  });

  it("waits for the routine's last run before promising continuity", async () => {
    localStorage.setItem("kin_routines_device", "self");
    const user = userEvent.setup();
    client.listRoutines.mockResolvedValue({
      routines: [routine({ model: "m1" })],
      has_more: false,
      next_cursor: "",
    });
    client.listRoutineRuns.mockResolvedValue([]);
    client.listTasks.mockReturnValue(new Promise(() => {}));
    renderPage();

    await user.click(await screen.findByRole("button", { name: "Edit Daily notes" }));
    expect(await screen.findByText(/reading the last run/i)).toBeTruthy();
  });

  it("says the next run starts over when the last run no longer matches", async () => {
    localStorage.setItem("kin_routines_device", "self");
    const user = userEvent.setup();
    client.listRoutines.mockResolvedValue({
      routines: [routine({ model: "m2" })],
      has_more: false,
      next_cursor: "",
    });
    const last = run({
      id: "run-1",
      routine_id: "routine-1",
      model: "m1",
      session_ref: "sess-1",
    });
    client.listRoutineRuns.mockResolvedValue([]);
    client.listTasks.mockResolvedValue([last]);
    renderPage();

    await user.click(await screen.findByRole("button", { name: "Edit Daily notes" }));
    // The daemon compares the newest run's settings; a model edit means the
    // next dispatch starts fresh, and the form must not promise the old one.
    expect(await screen.findByText(/last run cannot be continued/i)).toBeTruthy();
  });

  it("asks before a machine switch drops an open form", async () => {
    localStorage.setItem("kin_routines_device", "self");
    const user = userEvent.setup();
    renderPage();
    await openCreateForm(user);
    await paste(user, screen.getByPlaceholderText(/Review new PRs/i), "half-written plan");

    const confirm = vi.mocked(window.confirm).mockReturnValueOnce(false);
    await user.click(screen.getByRole("button", { name: /^Machine/ }));
    await user.click(await screen.findByText("Laptop"));
    expect(confirm).toHaveBeenCalled();
    // Staying keeps both the machine and the words.
    expect(screen.getByPlaceholderText(/Review new PRs/i)).toBeTruthy();
    expect(localStorage.getItem("kin_routines_device")).toBe("self");

    vi.mocked(window.confirm).mockReturnValueOnce(true);
    await user.click(screen.getByRole("button", { name: /^Machine/ }));
    await user.click(await screen.findByText("Laptop"));
    await waitFor(() =>
      expect(screen.queryByPlaceholderText(/Review new PRs/i)).toBeNull(),
    );
    expect(localStorage.getItem("kin_routines_device")).toBe("device-laptop");
  });

  it("disables every write when the chosen machine is offline", async () => {
    localStorage.setItem("kin_routines_device", "device-studio");
    client.listRoutines.mockResolvedValue({
      routines: [routine()],
      has_more: false,
      next_cursor: "",
    });
    client.listRoutineRuns.mockResolvedValue([]);
    renderPage();

    const row = (await screen.findByRole("button", { name: "Show the run records for Daily notes" }))
      .closest("li")!;
    for (const name of ["Run now", "Edit Daily notes", "Pause", "Delete"]) {
      expect(
        (within(row).getByRole("button", { name }) as HTMLButtonElement).disabled,
      ).toBe(true);
    }
    expect(
      (screen.getByRole("button", { name: "Mark all read" }) as HTMLButtonElement).disabled,
    ).toBe(true);
  });
});
