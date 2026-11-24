// @vitest-environment jsdom
import { beforeEach, describe, expect, it, vi } from "vitest";
import { render, screen, waitFor, within } from "@testing-library/react";
import userEvent from "@testing-library/user-event";
import { MemoryRouter, useLocation } from "react-router-dom";
import SessionList from "./SessionList";
import { setLocale } from "../../i18n";
import type { Machine } from "../../lib/devices";
import {
  ApiError,
  patchProject,
  type AgentSession,
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
 * The project row edits the project's working folders.
 *
 * The cover page is being retired, and its two editors have to live where a
 * person already chooses a project: the conversation list's project row. This
 * is the folder half on both pointers — one row in the coarse `⋯` sheet, a
 * hover-cluster button on a Mac opening the same editor as a dialog — and it
 * writes the whole ordered `roots` list through the same route and the same
 * failure contract as the cover's block, never the cover page and never a
 * partial merge.
 *
 * The eligibility rule is the row's own local-record rule: only this machine's
 * project record owns the folder list here, so a folder with no record offers
 * no editor at all.
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
    // The project is folded in these tests, so nothing reads a One-Pager; a
    // rejection keeps a stray read from painting a heading.
    getOnePager: vi.fn(async () => {
      throw new ApiError(404, "no one-pager");
    }),
    patchProject: vi.fn(),
  };
});

vi.mock("../../hooks/useMachines", () => ({
  useMachines: () => ({ machines: fixtures.machines, loading: false, failed: false }),
}));

const writeRoots = vi.mocked(patchProject);

const ALPHA = "/work/alpha";
const BETA = "/work/beta";
const GAMMA = "/work/gamma";

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

function projectRecord(roots: string[]): Project {
  return {
    id: "p1",
    name: "alpha",
    mode: "ship",
    status: "active",
    created_at: 1,
    updated_at: 1,
    last_active_at: 1,
    roots,
  } as Project;
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

/** Collapse the local project so its work-instructions block is not mounted. */
function collapseProject(cwd: string): void {
  localStorage.setItem(
    "kin_session_folds",
    JSON.stringify({ [`mac-1::${cwd.toLowerCase()}`]: false }),
  );
}

function openDialog(): HTMLElement {
  return screen.getByRole("dialog", { name: "Working folders" });
}

async function openFromCoarseMenu(): Promise<HTMLElement> {
  await userEvent.click(await screen.findByRole("button", { name: "Project actions" }));
  await userEvent.click(await screen.findByRole("button", { name: "Edit folders" }));
  return await screen.findByRole("dialog", { name: "Working folders" });
}

/** Pick a folder through the machine + cwd pickers, as the cover's block does. */
async function addFolder(dialog: HTMLElement, path: string): Promise<void> {
  await userEvent.click(within(dialog).getByRole("button", { name: /Add folder/ }));
  await userEvent.click(within(dialog).getByRole("button", { name: "Edit" }));
  // The manual-path field is a combobox: it carries the machine's roots as a
  // datalist, so the browser maps it to the combobox role.
  const field = within(dialog).getByRole("combobox");
  await userEvent.type(field, path);
  await userEvent.keyboard("{Enter}");
}

function folderRows(scope: HTMLElement): HTMLElement[] {
  return within(scope).getAllByRole("listitem");
}

beforeEach(() => {
  setLocale("en");
  localStorage.clear();
  sessionStorage.clear();
  writeRoots.mockReset();
  writeRoots.mockImplementation(async (id, body) => ({
    ...projectRecord(body.roots ?? []),
    id,
  }));
  collapseProject(ALPHA);
  fixtures.tasks = [task("alpha-work", ALPHA)];
  fixtures.projects = [projectRecord([ALPHA, BETA])];
  fixtures.machines = [
    {
      id: "mac-1",
      label: "MacBook",
      isSelf: true,
      online: true,
      roots: [GAMMA],
      agents: [],
    },
  ];
  fixtures.sessions = [];
  pointer("coarse");
});

describe("the project row's working-folders editor", () => {
  it("offers the working-folders editor from the project row and adds a folder", async () => {
    pointer("coarse");
    list();

    const dialog = await openFromCoarseMenu();
    const rows = folderRows(dialog);
    expect(rows[0]!.textContent).toContain(ALPHA);
    expect(within(rows[0]!).getByText("Default")).toBeTruthy();
    expect(rows[1]!.textContent).toContain(BETA);

    await addFolder(dialog, GAMMA);
    expect(within(dialog).getByText(GAMMA)).toBeTruthy();

    await userEvent.click(within(dialog).getByRole("button", { name: "Save folders" }));

    await waitFor(() =>
      expect(writeRoots).toHaveBeenCalledWith("p1", { roots: [ALPHA, BETA, GAMMA] }),
    );
    await waitFor(() =>
      expect(screen.queryByRole("dialog", { name: "Working folders" })).toBeNull(),
    );
    // The row redrew from the saved record: reopening shows the new list.
    const reopened = await openFromCoarseMenu();
    expect(within(reopened).getByText(GAMMA)).toBeTruthy();
    // Editing a project from its row never opens the cover page.
    expect(locationText()).toBe("/sessions");
  });

  it("names the coarse sheet row after the list it edits", async () => {
    // A bare 编辑 sat directly under 编辑一句话摘要, so the sheet offered two
    // rows a reader could not tell apart: one edits a summary, this one edits
    // the working folders. The seeded J4 walk could not identify the row
    // either, which is what this label fixes.
    setLocale("zh");
    list();

    await userEvent.click(await screen.findByRole("button", { name: "项目操作" }));
    await userEvent.click(await screen.findByRole("button", { name: "编辑工作目录" }));
    expect(await screen.findByRole("dialog", { name: "工作目录" })).toBeTruthy();
  });

  it("a fine pointer opens the working-folders editor from the hover cluster as a dialog", async () => {
    pointer("fine");
    list();

    // The trigger is the row's own hover cluster, not the coarse `⋯` menu:
    // the menu button does not exist on a fine pointer at all.
    const trigger = await screen.findByRole("button", { name: "Edit folders" });
    expect(screen.queryByRole("button", { name: "Project actions" })).toBeNull();

    await userEvent.click(trigger);

    const dialog = await screen.findByRole("dialog", { name: "Working folders" });
    // The Mac gets the sheet's centred desktop face, and — the part that
    // matters — the editor does not sit inside a native modal `<dialog>`: the
    // add row's machine menu and folder browser portal to `document.body`, and
    // a modal dialog would make everything outside itself inert.
    expect(dialog.tagName).toBe("DIV");
    expect(dialog.closest("dialog")).toBeNull();
    const surface = dialog.closest("[data-kin-sheet]");
    expect(surface?.className).toContain("md:items-center");
    expect(surface?.className).not.toContain("md:hidden");
    const rows = folderRows(dialog);
    expect(rows[0]!.textContent).toContain(ALPHA);
    expect(within(rows[0]!).getByText("Default")).toBeTruthy();
    expect(rows[1]!.textContent).toContain(BETA);

    await addFolder(dialog, GAMMA);
    await userEvent.click(within(dialog).getByRole("button", { name: "Save folders" }));

    await waitFor(() =>
      expect(writeRoots).toHaveBeenCalledWith("p1", { roots: [ALPHA, BETA, GAMMA] }),
    );
    await waitFor(() =>
      expect(screen.queryByRole("dialog", { name: "Working folders" })).toBeNull(),
    );
    // Closing returns focus to the button it was opened from.
    await waitFor(() => expect(document.activeElement).toBe(trigger));
  });

  it("make default saves the whole list with that folder first", async () => {
    pointer("coarse");
    list();

    const dialog = await openFromCoarseMenu();
    await userEvent.click(within(dialog).getByRole("button", { name: "Make default" }));
    await userEvent.click(within(dialog).getByRole("button", { name: "Save folders" }));

    await waitFor(() => expect(writeRoots).toHaveBeenCalledWith("p1", { roots: [BETA, ALPHA] }));
  });

  it("removing a folder saves the rest; the last folder cannot be removed", async () => {
    pointer("coarse");
    list();

    const dialog = await openFromCoarseMenu();
    await userEvent.click(within(dialog).getAllByRole("button", { name: "Remove" })[1]!);
    const confirm = within(dialog).getByRole("group", { name: `Remove ${BETA}?` });
    await userEvent.click(within(confirm).getByRole("button", { name: "Remove" }));
    await userEvent.click(within(dialog).getByRole("button", { name: "Save folders" }));

    await waitFor(() => expect(writeRoots).toHaveBeenCalledWith("p1", { roots: [ALPHA] }));

    const reopened = await openFromCoarseMenu();
    expect(folderRows(reopened)).toHaveLength(1);
    await userEvent.click(within(reopened).getByRole("button", { name: "Remove" }));
    const lastConfirm = within(reopened).getByRole("group", { name: `Remove ${ALPHA}?` });
    expect(
      within(lastConfirm).getByText("New chats will have nowhere to start (New chat is disabled)."),
    ).toBeTruthy();
    // The last folder is the project's only way to exist on this row, so the
    // confirmation refuses rather than emptying the list.
    const lastRemove = within(lastConfirm).getByRole("button", {
      name: "Remove",
    }) as HTMLButtonElement;
    expect(lastRemove.disabled).toBe(true);
    await userEvent.click(lastRemove);
    expect(within(reopened).getByText(ALPHA)).toBeTruthy();
    expect(writeRoots).toHaveBeenCalledTimes(1);
  });

  it("a failed save keeps the draft and says why", async () => {
    writeRoots.mockRejectedValueOnce(new Error(""));
    pointer("coarse");
    list();

    const dialog = await openFromCoarseMenu();
    await addFolder(dialog, GAMMA);
    await userEvent.click(within(dialog).getByRole("button", { name: "Save folders" }));

    expect(await within(dialog).findByText("Could not save the folder list")).toBeTruthy();
    // No silent rollback: the added folder and the open editor both stay.
    expect(within(dialog).getByText(GAMMA)).toBeTruthy();
    expect(openDialog()).toBe(dialog);
  });

  it("a 403 save says this machine does not own the folder list", async () => {
    writeRoots.mockRejectedValueOnce(new ApiError(403, "forbidden"));
    pointer("coarse");
    list();

    const dialog = await openFromCoarseMenu();
    await addFolder(dialog, GAMMA);
    await userEvent.click(within(dialog).getByRole("button", { name: "Save folders" }));

    expect(
      await within(dialog).findByText(
        "You do not have permission to change this project's folders.",
      ),
    ).toBeTruthy();
    expect(within(dialog).getByText(GAMMA)).toBeTruthy();
    expect(openDialog()).toBe(dialog);
  });

  it("a bucket with no local project record offers no working-folders entry", async () => {
    fixtures.projects = [];
    pointer("coarse");
    list();

    await userEvent.click(await screen.findByRole("button", { name: "Project actions" }));
    // The sheet opened — it still offers the actions that work without a
    // record — and it has no folder row.
    expect(await screen.findByRole("button", { name: "New conversation in alpha" })).toBeTruthy();
    expect(screen.queryByRole("button", { name: "Edit folders" })).toBeNull();
  });

  it("a fine pointer with no local project record offers no working-folders entry", async () => {
    fixtures.projects = [];
    pointer("fine");
    list();

    // The hover cluster is there (a new conversation still works without a
    // record), but the folder list belongs to the local record, so its
    // button is absent exactly as the coarse menu's row is.
    expect(await screen.findByRole("button", { name: "New conversation in alpha" })).toBeTruthy();
    expect(screen.queryByRole("button", { name: "Edit folders" })).toBeNull();
  });

  it("closing with unsaved folders asks before discarding", async () => {
    const confirm = vi.spyOn(window, "confirm").mockReturnValue(false);
    list();

    const dialog = await openFromCoarseMenu();
    await userEvent.click(within(dialog).getByRole("button", { name: "Make default" }));

    await userEvent.keyboard("{Escape}");
    expect(confirm).toHaveBeenCalledWith("Folder changes are not saved. Discard them?");
    expect(openDialog()).toBe(dialog);
    // The draft survived the cancelled close: beta is now first and default.
    const rows = folderRows(dialog);
    expect(rows[0]!.textContent).toContain(BETA);
    expect(within(rows[0]!).getByText("Default")).toBeTruthy();

    confirm.mockReturnValue(true);
    await userEvent.keyboard("{Escape}");
    await waitFor(() =>
      expect(screen.queryByRole("dialog", { name: "Working folders" })).toBeNull(),
    );
  });
});
