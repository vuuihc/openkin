// @vitest-environment jsdom
import type { ReactElement } from "react";
import { fireEvent, render, screen, within } from "@testing-library/react";
import { describe, expect, it, vi } from "vitest";
import { MemoryRouter } from "react-router-dom";
import type { Task } from "../../api/client";
import { t } from "../../i18n";
import TaskHeader, { type TaskHeaderProps } from "./TaskHeader";

/**
 * The conversation header, extracted from `TaskDetailPage`.
 *
 * What is pinned here is the split the extraction must not blur: the phone
 * bar owns the title and the overflow trigger, the desktop bar owns the
 * verbs, and both are driven entirely by the callbacks the page passes in.
 * If a control ever grows its own handler, one of these clicks stops reaching
 * the page.
 */

const task: Task = {
  id: "task-1",
  title: "Fix the header",
  agent: "kin",
  cwd: "/tmp/example",
  prompt: "Fix the header",
  status: "running",
  tokens_in: 0,
  tokens_out: 0,
  created_at: 1_700_000_000_000,
  event_epoch: 0,
};

function setup(overrides: Partial<TaskHeaderProps> = {}) {
  const props: TaskHeaderProps = {
    task,
    hostAgentName: "Kin",
    hostAgentAvatar: { initials: "K", className: "bg-kin-blue text-kin-on-brand" },
    project: "openkin",
    terminal: false,
    degraded: false,
    filesOpen: false,
    panelOpen: false,
    archiving: false,
    deleting: false,
    stopping: false,
    onToggleWorkspace: vi.fn(),
    onShare: vi.fn(),
    onToggleArchive: vi.fn(),
    onDelete: vi.fn(),
    onStop: vi.fn(),
    onBack: vi.fn(),
    onOpenActions: vi.fn(),
    onShowList: vi.fn(),
    ...overrides,
  };
  const view: ReactElement = (
    <MemoryRouter>
      <TaskHeader {...props} />
    </MemoryRouter>
  );
  const utils = render(view);
  return { props, utils };
}

/** The phone bar is the only `<header>` on the screen. */
function phoneBar(utils: ReturnType<typeof setup>["utils"]) {
  return within(utils.container.querySelector("header") as HTMLElement);
}

/**
 * The desktop bar is the phone bar's sibling. The two bars are one another's
 * mirror image at the `md` breakpoint: the phone bar carries `md:hidden` and
 * the desktop bar carries `hidden md:flex`. Reading the sibling rather than a
 * test id keeps the assertion about the split the component actually renders.
 */
function desktopBar(utils: ReturnType<typeof setup>["utils"]) {
  return (utils.container.querySelector("header") as HTMLElement).nextElementSibling as HTMLElement;
}

/** The phone bar's own element, for assertions the query helpers cannot scope. */
function phoneBarEl(utils: ReturnType<typeof setup>["utils"]) {
  return utils.container.querySelector("header") as HTMLElement;
}

/** The live-status pill, whichever row it is drawn in. */
function statusPill(bar: HTMLElement) {
  return bar.querySelector("[data-task-status]") as HTMLElement | null;
}

describe("TaskHeader", () => {
  it("keeps the phone and desktop bars on opposite sides of the md breakpoint", () => {
    const { utils } = setup();
    const phone = utils.container.querySelector("header") as HTMLElement;
    const desktop = desktopBar(utils);

    expect(phone.className.split(/\s+/)).toContain("md:hidden");
    expect(desktop.className.split(/\s+/)).toContain("hidden");
    expect(desktop.className.split(/\s+/)).toContain("md:flex");
  });

  it("renders the phone header with the session title and a back button", () => {
    const { props, utils } = setup();
    const header = phoneBar(utils);
    expect(header.getByText("Fix the header")).toBeTruthy();

    const back = header.getByRole("button", { name: t("app.back") });
    fireEvent.click(back);
    expect(props.onBack).toHaveBeenCalledTimes(1);
  });

  it("renders the desktop header with the host chip, workspace, share, archive and delete buttons", () => {
    const { props, utils } = setup();
    const desktop = within(desktopBar(utils));

    expect(desktop.getByText(t("newChat.hostAgent", { name: "Kin" }))).toBeTruthy();

    const workspace = desktop.getByRole("button", { name: t("workspace.title") });
    const share = desktop.getByRole("button", { name: t("task.share") });
    const archive = desktop.getByRole("button", { name: t("task.archiveSession") });
    const del = desktop.getByRole("button", { name: t("task.deleteSession") });

    fireEvent.click(workspace);
    fireEvent.click(share);
    fireEvent.click(archive);
    fireEvent.click(del);

    expect(props.onToggleWorkspace).toHaveBeenCalledTimes(1);
    expect(props.onShare).toHaveBeenCalledTimes(1);
    expect(props.onToggleArchive).toHaveBeenCalledTimes(1);
    expect(props.onDelete).toHaveBeenCalledTimes(1);
  });

  it("desktop: stop button appears only while the session is live", () => {
    const { props } = setup();
    const stop = screen.getByRole("button", { name: t("composer.stop") });
    fireEvent.click(stop);
    expect(props.onStop).toHaveBeenCalledTimes(1);
  });

  it("desktop: no stop button once the session is terminal", () => {
    setup({ terminal: true });
    expect(screen.queryByRole("button", { name: t("composer.stop") })).toBeNull();
    expect(screen.queryByText(t("task.running"))).toBeNull();
  });

  it("desktop: project name is a link when task.project_id is set", () => {
    setup({ task: { ...task, project_id: "project 1/2" } });
    const link = screen.getByRole("link", { name: "openkin" });
    expect(link.getAttribute("href")).toBe(`/projects/${encodeURIComponent("project 1/2")}`);
  });

  it("desktop: project name is plain text without a project_id", () => {
    const { utils } = setup();
    expect(screen.queryByRole("link", { name: "openkin" })).toBeNull();
    // The phone subtitle also says "openkin" now, so the row is read from the
    // desktop bar rather than from the whole screen.
    expect(within(desktopBar(utils)).getByText("openkin")).toBeTruthy();
  });

  it("phone: the trailing ⋯ button opens the action sheet via the passed-in onOpenActions callback", () => {
    const { props, utils } = setup();
    const more = phoneBar(utils).getByRole("button", { name: t("task.sessionActions") });
    fireEvent.click(more);
    expect(props.onOpenActions).toHaveBeenCalledTimes(1);
  });

  it("phone: puts the live status in a non-wrapping pill on the subtitle row", () => {
    const { utils } = setup();
    const pill = statusPill(phoneBarEl(utils));

    expect(pill).not.toBeNull();
    expect(pill?.textContent).toBe(t("task.running"));
    const classes = (pill as HTMLElement).className.split(/\s+/);
    expect(classes).toContain("whitespace-nowrap");
    expect(classes.includes("flex-none") || classes.includes("shrink-0")).toBe(true);
  });

  it("phone: the subtitle keeps the project and adds the branch", () => {
    const { utils } = setup({ task: { ...task, workspace_branch: "rsi/header-pill" } });
    const pill = statusPill(phoneBarEl(utils)) as HTMLElement;
    const row = pill.parentElement as HTMLElement;

    // The pill, project and branch share one row: the row is the pill's own
    // parent, so a layout that pushed any of them elsewhere fails here.
    expect(row.className.split(/\s+/)).toContain("flex");
    expect(row.textContent).toContain("openkin");
    expect(row.textContent).toContain("rsi/header-pill");
    expect(row.textContent).toContain(t("task.running"));
  });

  it("phone: hides the status pill once the turn is terminal", () => {
    const { utils } = setup({ terminal: true });
    const phone = phoneBarEl(utils);

    expect(statusPill(phone)).toBeNull();
    expect(phoneBar(utils).queryByText(t("task.running"))).toBeNull();
  });

  it("phone: says reconnect in the pill while the live stream is degraded", () => {
    const { utils } = setup({ degraded: true });

    expect(statusPill(phoneBarEl(utils))?.textContent).toBe(t("task.reconnect"));
  });

  it("desktop: draws the status as a pill and keeps the panel toggle working", () => {
    const { props, utils } = setup();
    const desktop = desktopBar(utils);

    expect(statusPill(desktop)?.textContent).toBe(t("task.running"));

    fireEvent.click(within(desktop).getByRole("button", { name: t("workspace.title") }));
    expect(props.onToggleWorkspace).toHaveBeenCalledTimes(1);
  });

  it("desktop: every verb still reaches its callback through the facade", () => {
    const { props, utils } = setup();
    const desktop = within(desktopBar(utils));

    fireEvent.click(desktop.getByRole("button", { name: t("workspace.title") }));
    fireEvent.click(desktop.getByRole("button", { name: t("task.share") }));
    fireEvent.click(desktop.getByRole("button", { name: t("task.archiveSession") }));
    fireEvent.click(desktop.getByRole("button", { name: t("task.deleteSession") }));
    fireEvent.click(desktop.getByRole("button", { name: t("composer.stop") }));

    expect(props.onToggleWorkspace).toHaveBeenCalledTimes(1);
    expect(props.onShare).toHaveBeenCalledTimes(1);
    expect(props.onToggleArchive).toHaveBeenCalledTimes(1);
    expect(props.onDelete).toHaveBeenCalledTimes(1);
    expect(props.onStop).toHaveBeenCalledTimes(1);
  });

  it("offers Show list only while a panel is open", () => {
    // The list column yields to the open panel (S1b), so this is the one
    // control that brings it back — by closing the panel, because both at once
    // is the squeeze TASTE 17 forbids.
    const { props, utils } = setup({ panelOpen: true });
    const show = within(desktopBar(utils)).getByRole("button", { name: t("nav.showList") });
    fireEvent.click(show);
    expect(props.onShowList).toHaveBeenCalledTimes(1);
    utils.unmount();

    setup({ panelOpen: false });
    expect(screen.queryByRole("button", { name: t("nav.showList") })).toBeNull();
  });

  it("keeps the phone bar unchanged", () => {
    // The phone has no list column: its list is the page, and a control that
    // reveals a column it does not have is the phone control TASTE 3 forbids
    // on the Mac surface (and vice versa).
    const { utils } = setup({ panelOpen: true });
    expect(within(phoneBarEl(utils)).queryByRole("button", { name: t("nav.showList") })).toBeNull();
  });

  it("desktop: keeps archive and delete disabled while their action is in flight", () => {
    const { utils } = setup({ archiving: true, deleting: true });
    const desktop = within(desktopBar(utils));

    const archive = desktop.getByRole("button", { name: t("task.archiveSession") });
    const del = desktop.getByRole("button", { name: t("task.deleteSession") });

    expect((archive as HTMLButtonElement).disabled).toBe(true);
    expect((del as HTMLButtonElement).disabled).toBe(true);
  });
});
