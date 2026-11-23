// @vitest-environment jsdom
import { beforeEach, describe, expect, it, vi } from "vitest";
import { render, screen, waitFor, within } from "@testing-library/react";
import userEvent from "@testing-library/user-event";
import { MemoryRouter, useLocation } from "react-router-dom";
import SessionList from "./SessionList";
import { setLocale } from "../../i18n";
import { onePagerFocus, setOnePagerFocus } from "../../lib/onePagerSummary";
import type { Machine } from "../../lib/devices";
import {
  ApiError,
  getOnePager,
  putOnePager,
  type AgentSession,
  type OnePager,
  type Project,
  type Task,
} from "../../api/client";

/*
 * jsdom renders <dialog> but implements neither showModal() nor the top
 * layer, so the local stand-in tracks the open attribute and the close event.
 */
if (!HTMLDialogElement.prototype.showModal) {
  HTMLDialogElement.prototype.showModal = function showModal(this: HTMLDialogElement) {
    this.setAttribute("open", "");
  };
}
if (!HTMLDialogElement.prototype.close) {
  HTMLDialogElement.prototype.close = function close(this: HTMLDialogElement) {
    this.removeAttribute("open");
    this.dispatchEvent(new Event("close"));
  };
}

/**
 * The project row edits the project's one-line summary.
 *
 * The cover page is being retired, and its two editors have to live where a
 * person already chooses a project: the conversation list's project row. This
 * is the summary half — one row in the coarse `⋯` sheet, one pencil in the
 * fine-pointer hover cluster — and it writes the One-Pager's Current Focus
 * through the existing route, never the whole document and never the cover.
 *
 * The eligibility rule is the one the row already uses for its work
 * instructions: only this machine's project record has a One-Pager here, so a
 * remote copy of the same path and a local folder with no record offer no
 * editor at all.
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
    listAgentSessionsPage: vi.fn(async () => ({
      items: fixtures.sessions,
      next_cursor: undefined,
    })),
    listProjects: vi.fn(async () => fixtures.projects),
    listTasks: vi.fn(async () => []),
    ensureProject: vi.fn(async () => ({ id: "p", name: "alpha" })),
    getOnePager: vi.fn(),
    putOnePager: vi.fn(),
  };
});

vi.mock("../../hooks/useMachines", () => ({
  useMachines: () => ({ machines: fixtures.machines, loading: false, failed: false }),
}));

const readOnePager = vi.mocked(getOnePager);
const writeOnePager = vi.mocked(putOnePager);

const ROOT = "/tmp/alpha";
const BASE =
  "# alpha\n\n## Current Focus\n\nShip the list editor.\n\n## North Star\n\nKeep one line.\n";
const BASE_UPDATED_AT = 41;

function pointer(kind: "fine" | "coarse") {
  vi.stubGlobal("matchMedia", (query: string) => ({
    matches: query === "(pointer: coarse)" ? kind === "coarse" : false,
    media: query,
    onchange: null,
    addEventListener: vi.fn(),
    removeEventListener: vi.fn(),
    addListener: vi.fn(),
    removeListener: vi.fn(),
    dispatchEvent: vi.fn(),
  }));
}

function task(id: string, cwd: string, options: { device?: string } = {}): Task {
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
    ...(options.device ? { executing_device_id: options.device } : {}),
  } as Task;
}

function project(id: string, name: string, root: string | string[]): Project {
  return {
    id,
    name,
    mode: "ship",
    status: "active",
    created_at: 1,
    updated_at: 1,
    last_active_at: 1,
    roots: Array.isArray(root) ? root : [root],
  } as Project;
}

function onePager(markdown: string, updatedAt: number): OnePager {
  return { project_id: "p1", markdown, updated_at: updatedAt };
}

function LocationProbe() {
  const location = useLocation();
  return (
    <output data-testid="location">
      {location.pathname}
      {location.search}
    </output>
  );
}

function list() {
  return render(
    <MemoryRouter initialEntries={["/sessions"]}>
      <SessionList shell="page" />
      <LocationProbe />
    </MemoryRouter>,
  );
}

function locationText(): string {
  return screen.getByTestId("location").textContent ?? "";
}

/**
 * Collapse the local project so its work-instructions block is not mounted:
 * the only `getOnePager` call in these tests is the editor's own read.
 */
function collapseProject(cwd: string): void {
  localStorage.setItem(
    "kin_session_folds",
    JSON.stringify({ [`mac-1::${cwd.toLowerCase()}`]: false }),
  );
}

async function openEditorFromPencil(): Promise<HTMLElement> {
  await userEvent.click(await screen.findByRole("button", { name: "Edit one-line summary" }));
  const dialog = await screen.findByRole("dialog", { name: "Edit one-line summary" });
  return dialog;
}

async function summaryField(scope: HTMLElement): Promise<HTMLTextAreaElement> {
  const field = await within(scope).findByRole("textbox", { name: "One-line summary" });
  return field as HTMLTextAreaElement;
}

beforeEach(() => {
  setLocale("en");
  localStorage.clear();
  sessionStorage.clear();
  readOnePager.mockReset();
  writeOnePager.mockReset();
  readOnePager.mockResolvedValue(onePager(BASE, BASE_UPDATED_AT));
  writeOnePager.mockResolvedValue(onePager(BASE, BASE_UPDATED_AT + 1));
  collapseProject(ROOT);
  fixtures.tasks = [task("alpha-work", ROOT)];
  fixtures.projects = [project("p1", "alpha", ROOT)];
  fixtures.machines = [
    { id: "mac-1", label: "MacBook", isSelf: true, online: true, roots: [], agents: [] },
  ];
  fixtures.sessions = [];
  pointer("fine");
});

describe("the project row's one-line summary editor", () => {
  it("opens from the coarse project menu with the current line", async () => {
    pointer("coarse");
    list();

    await userEvent.click(await screen.findByRole("button", { name: "Project actions" }));
    const row = await screen.findByRole("button", { name: "Edit one-line summary" });
    // Opening the menu is not a One-Pager read; only the editor loads one.
    expect(readOnePager).not.toHaveBeenCalled();

    await userEvent.click(row);

    const field = await summaryField(
      await screen.findByRole("dialog", {
        name: "Edit one-line summary",
      }),
    );
    await waitFor(() => expect(field.value).toBe(onePagerFocus(BASE)));
    expect(readOnePager).toHaveBeenCalledTimes(1);
    expect(readOnePager).toHaveBeenCalledWith("p1");
  });

  it("saving writes the focus line through putOnePager and closes", async () => {
    list();

    const dialog = await openEditorFromPencil();
    const field = await summaryField(dialog);
    await waitFor(() => expect(field.value).toBe(onePagerFocus(BASE)));

    await userEvent.clear(field);
    await userEvent.type(field, "Ship the row editor.");
    await userEvent.click(within(dialog).getByRole("button", { name: "Save" }));

    await waitFor(() => expect(writeOnePager).toHaveBeenCalledTimes(1));
    // The focus line, composed into the version the editor opened — never the
    // whole document and never a bare string.
    expect(writeOnePager).toHaveBeenCalledWith(
      "p1",
      setOnePagerFocus(BASE, "Ship the row editor."),
      BASE_UPDATED_AT,
    );
    await waitFor(() =>
      expect(screen.queryByRole("textbox", { name: "One-line summary" })).toBeNull(),
    );
  });

  it("a 409 offers their version and keeps mine", async () => {
    const theirsMarkdown =
      "# alpha\n\n## Current Focus\n\nTheir newer line.\n\n## North Star\n\nKeep one line.\n";
    const theirsUpdatedAt = 77;
    readOnePager
      .mockResolvedValueOnce(onePager(BASE, BASE_UPDATED_AT))
      .mockResolvedValueOnce(onePager(theirsMarkdown, theirsUpdatedAt))
      .mockResolvedValueOnce(onePager(theirsMarkdown, theirsUpdatedAt));
    writeOnePager
      .mockRejectedValueOnce(new ApiError(409, "conflict"))
      .mockRejectedValueOnce(new ApiError(409, "conflict"))
      .mockResolvedValueOnce(onePager(theirsMarkdown, theirsUpdatedAt + 1));
    list();

    const dialog = await openEditorFromPencil();
    const field = await summaryField(dialog);
    await userEvent.clear(field);
    await userEvent.type(field, "Mine wins.");
    await userEvent.click(within(dialog).getByRole("button", { name: "Save" }));

    // The conflict is a state of the editor: their line, and the same words
    // the cover's editor uses.
    expect(
      await within(dialog).findByText("This cover changed elsewhere. Their version:"),
    ).toBeTruthy();
    expect(within(dialog).getByText("Their newer line.")).toBeTruthy();

    // "Use their version" replaces the draft with their focus line.
    await userEvent.click(within(dialog).getByRole("button", { name: "Use their version" }));
    await waitFor(() => expect(field.value).toBe(onePagerFocus(theirsMarkdown)));

    // A later save meets the same conflict; "keep mine" composes on their
    // document and saves against their version, not the stale one.
    await userEvent.clear(field);
    await userEvent.type(field, "Mine, on top of theirs.");
    await userEvent.click(within(dialog).getByRole("button", { name: "Save" }));
    expect(
      await within(dialog).findByText("This cover changed elsewhere. Their version:"),
    ).toBeTruthy();
    await userEvent.click(within(dialog).getByRole("button", { name: "Keep mine and overwrite" }));

    await waitFor(() => expect(writeOnePager).toHaveBeenCalledTimes(3));
    expect(writeOnePager).toHaveBeenLastCalledWith(
      "p1",
      setOnePagerFocus(theirsMarkdown, "Mine, on top of theirs."),
      theirsUpdatedAt,
    );
  });

  it("a bucket with no local project record offers no summary editor", async () => {
    fixtures.projects = [];
    pointer("coarse");
    const coarseList = list();

    await userEvent.click(await screen.findByRole("button", { name: "Project actions" }));
    // The sheet opened — it still offers the actions that work without a
    // record — and it has no summary row.
    expect(await screen.findByRole("button", { name: "New conversation in alpha" })).toBeTruthy();
    expect(screen.queryByRole("button", { name: "Edit one-line summary" })).toBeNull();
    coarseList.unmount();

    localStorage.clear();
    collapseProject(ROOT);
    pointer("fine");
    list();
    await screen.findByRole("button", { name: "alpha" });
    // The fine cluster is CSS-revealed, so its absence here is a decision in
    // the tree, not a hover state.
    expect(screen.queryByRole("button", { name: "Edit one-line summary" })).toBeNull();
  });

  it("the fine-pointer pencil opens the same editor without opening the cover", async () => {
    list();

    expect(locationText()).toBe("/sessions");
    await userEvent.hover(await screen.findByRole("button", { name: "alpha" }));
    const dialog = await openEditorFromPencil();

    expect(dialog).toBeTruthy();
    await summaryField(dialog);
    // The pencil edits in place; it must not navigate to /projects/p1.
    expect(locationText()).toBe("/sessions");
  });

  it("a load failure shows the existing error and can retry", async () => {
    readOnePager
      .mockRejectedValueOnce(new Error("boom"))
      .mockResolvedValueOnce(onePager(BASE, BASE_UPDATED_AT));
    list();

    const dialog = await openEditorFromPencil();
    expect(await within(dialog).findByText("The summary is unavailable right now")).toBeTruthy();

    await userEvent.click(within(dialog).getByRole("button", { name: "Retry" }));

    const field = await summaryField(dialog);
    await waitFor(() => expect(field.value).toBe(onePagerFocus(BASE)));
    expect(readOnePager).toHaveBeenCalledTimes(2);
  });
});
