// @vitest-environment jsdom
// KIN-QUALITY-001: the 820 header keeps title, project label, files count and
// the existing ⋯. jsdom proves structure; the 44 px geometry is the walk.
import type { ReactElement } from "react";
import { fireEvent, render, screen, within } from "@testing-library/react";
import { describe, expect, it, vi } from "vitest";
import { MemoryRouter } from "react-router-dom";
import type { Task } from "../../api/client";
import { t } from "../../i18n";
import TaskHeader, { type TaskHeaderProps } from "./TaskHeader";
const task = {
  id: "task-1",
  title: "Read the long answer before asking again",
  agent: "kin",
  cwd: "/work/alpha",
  prompt: "read it",
  status: "running",
  tokens_in: 0,
  tokens_out: 0,
  created_at: 1_700_000_000_000,
  event_epoch: 0,
} as unknown as Task;
const baseProps: TaskHeaderProps = {
  task,
  hostAgentName: "Kin",
  hostAgentAvatar: { initials: "K", className: "bg-kin-blue text-kin-on-brand" },
  project: "openkin",
  terminal: false,
  degraded: false,
  filesOpen: false,
  panelOpen: false,
  prOpen: false,
  archiving: false,
  deleting: false,
  stopping: false,
  onToggleWorkspace: vi.fn(),
  onTogglePr: vi.fn(),
  onShare: vi.fn(),
  onToggleArchive: vi.fn(),
  onDelete: vi.fn(),
  onStop: vi.fn(),
  onBack: vi.fn(),
  onOpenActions: vi.fn(),
  onShowList: vi.fn(),
};
function setup(overrides: Partial<TaskHeaderProps> = {}) {
  const props: TaskHeaderProps = { ...baseProps, ...overrides };
  const view: ReactElement = (
    <MemoryRouter>
      <TaskHeader {...props} />
    </MemoryRouter>
  );
  return { props, utils: render(view) };
}
/** The desktop bar is the one `phone={false}` renders. */
function desktopBar(utils: ReturnType<typeof setup>["utils"]) {
  return utils.container.querySelector('[data-task-header="desktop"]') as HTMLElement;
}
describe("TaskHeader KIN-QUALITY-001", () => {
  it("820 touch: the compact header keeps only the title, project, files entry and actions trigger", () => {
    const { utils } = setup({ compact: true, changedFileCount: 2 });
    const bar = desktopBar(utils);
    const view = within(bar);
    expect(view.getByText("Read the long answer before asking again")).toBeTruthy();
    // The project answers "which session is this" and is not a third action.
    expect(view.getByText("openkin")).toBeTruthy();
    expect(bar.querySelectorAll("a")).toHaveLength(0);
    // The accessible name is the control's own word; the count is visible
    // text beside it, never part of the name (label-in-name and the walk's
    // `button[aria-label='文件']` both need the stable name).
    const files = view.getByRole("button", { name: t("workspace.title") });
    expect(files.textContent).toContain("2");
    expect(files.getAttribute("aria-label")).toBe(t("workspace.title"));
    expect(view.getByRole("button", { name: t("task.sessionActions") })).toBeTruthy();
    // Only those two controls; every other verb comes from the page's sheet.
    expect(view.getAllByRole("button")).toHaveLength(2);
    for (const label of [
      t("pr.title"),
      t("task.share"),
      t("task.archiveSession"),
      t("task.deleteSession"),
      t("composer.stop"),
    ]) {
      expect(view.queryByRole("button", { name: label })).toBeNull();
    }
    expect(view.queryByText(t("newChat.hostAgent", { name: "Kin" }))).toBeNull();
  });
  it("every compact header control is a button or link with an accessible name, 44px tall", () => {
    const { utils } = setup({ compact: true, changedFileCount: 1 });
    const controls = [...desktopBar(utils).querySelectorAll<HTMLElement>("button, a[href]")];
    expect(controls.length).toBeGreaterThan(0);
    for (const control of controls) {
      const name = (
        control.getAttribute("aria-label") ||
        control.getAttribute("title") ||
        control.textContent ||
        ""
      ).trim();
      expect(
        name.length,
        `${control.outerHTML.slice(0, 80)} has no accessible name`,
      ).toBeGreaterThan(0);
      // `h-11` is the 44 px floor; the browser row proves the rendered box.
      expect(control.className.split(/\s+/), name).toContain("h-11");
      expect(control.className.split(/\s+/), name).toContain("min-w-11");
    }
  });
  it("the compact header's actions trigger is the page's one session-actions entry", () => {
    const { props, utils } = setup({ compact: true, changedFileCount: 0 });
    fireEvent.click(
      within(desktopBar(utils)).getByRole("button", { name: t("task.sessionActions") }),
    );
    expect(props.onOpenActions).toHaveBeenCalledTimes(1);
    // The header does not grow a sheet of its own; the page's ActionSheet opens.
    expect(utils.container.querySelector('[role="dialog"]')).toBeNull();
  });
  it("390 running: the phone bar is one row and the live state is not a second line", () => {
    // The story's frame 01 draws one 44 px band: back · title · 文件 · ⋯. A
    // second line holding the live pill and the project crammed the title
    // against the top edge and the pill against the hairline (density 2).
    const { utils } = setup({
      phone: true,
      task: { ...task, workspace_branch: "rsi/one-row" },
    });
    const banner = screen.getByRole("banner");

    // No live-state pill and no project · branch subtitle: neither word is in
    // the bar, so nothing can push the title onto a second line.
    expect(banner.querySelector("[data-task-status]")).toBeNull();
    expect(within(banner).queryByText(t("task.running"))).toBeNull();
    expect(within(banner).queryByText(t("task.reconnect"))).toBeNull();
    expect(banner.textContent).not.toContain("openkin");
    expect(banner.textContent).not.toContain("rsi/one-row");
    expect(banner.querySelectorAll("h1")).toHaveLength(1);

    // Title and ⋯ share the bar's one grid row: the heading's own cell and the
    // trailing trigger both descend from the same row element.
    const title = banner.querySelector("h1") as HTMLElement;
    const more = within(banner).getByRole("button", { name: t("task.sessionActions") });
    const row = title.parentElement?.parentElement as HTMLElement;
    expect(row.className.split(/\s+/)).toContain("grid");
    expect(row.contains(more)).toBe(true);
    expect(utils.container.querySelector('[data-task-header="desktop"]')).toBeNull();
  });
});
