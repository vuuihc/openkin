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

/** The phone bar is the only `<header>` on the screen, and only at `phone`. */
function phoneBar(utils: ReturnType<typeof setup>["utils"]) {
  return within(utils.container.querySelector("header") as HTMLElement);
}

/**
 * The desktop bar is the one `phone={false}` renders. Exactly one bar is in
 * the DOM at a time, so it is read directly rather than as the phone bar's
 * sibling — two bars meant two controls with the same accessible name.
 */
function desktopBar(utils: ReturnType<typeof setup>["utils"]) {
  return utils.container.querySelector('[data-task-header="desktop"]') as HTMLElement;
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
  it("renders exactly one bar per width, never both CSS-hidden in the DOM", () => {
    const phone = setup({ phone: true });
    expect(phoneBarEl(phone.utils).className.split(/\s+/)).toContain("md:hidden");
    expect(phone.utils.container.querySelector('[data-task-header="desktop"]')).toBeNull();
    phone.utils.unmount();

    const desktop = setup();
    expect(desktop.utils.container.querySelector("header")).toBeNull();
    const classes = desktopBar(desktop.utils).className.split(/\s+/);
    expect(classes).toContain("hidden");
    expect(classes).toContain("md:flex");
  });

  it("renders the phone header with the session title and a back button", () => {
    const { props, utils } = setup({ phone: true });
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

  it("desktop: keeps the conversation title readable when the row is crowded", () => {
    const { utils } = setup();
    const desktop = within(desktopBar(utils));

    // A `flex-1` title with no floor collapsed to its first character once a
    // right-side panel narrowed the row; the verbs are what give way instead.
    const titleBlock = desktop.getByText("Fix the header").parentElement as HTMLElement;
    expect(titleBlock.className.split(/\s+/)).toContain("min-w-cell");

    // Secondary verbs keep their icon, name and tooltip but lose the word
    // below the bar's own verb floor (a container query, not the viewport:
    // an open panel narrows the bar long before the window narrows).
    const compacted = [
      within(desktop.getByRole("button", { name: t("workspace.title") })).getByText(
        t("workspace.title"),
      ),
      within(desktop.getByRole("button", { name: t("task.share") })).getByText(t("task.share")),
      desktop.getByText(t("newChat.hostAgent", { name: "Kin" })),
    ];
    for (const label of compacted) {
      const classes = label.className.split(/\s+/);
      expect(classes).toContain("hidden");
      expect(classes).toContain("@min-[1140px]:inline");
    }
  });

  it("desktop: every icon+word verb holds its icon and word on one line", () => {
    const { utils } = setup();
    const desktop = within(desktopBar(utils));

    // Astryx wraps children in one inline span and preflight makes an `<svg>`
    // a block box: without the flex row the icon took its own line and the
    // word was clipped underneath it.
    for (const label of [t("workspace.title"), t("pr.title"), t("task.share")]) {
      const content = desktop.getByText(label).parentElement as HTMLElement;
      const classes = content.className.split(/\s+/);
      expect(classes, label).toContain("inline-flex");
      expect(classes, label).toContain("items-center");
      expect(classes, label).toContain("whitespace-nowrap");
    }
    // A shrinking verb truncated its label to "文件 ..."; the verbs are now
    // fixed and the cluster scrolls instead.
    for (const label of [
      t("workspace.title"),
      t("pr.title"),
      t("task.share"),
      t("task.archiveSession"),
      t("task.deleteSession"),
    ]) {
      expect(desktop.getByRole("button", { name: label }).className.split(/\s+/), label).toContain(
        "flex-none",
      );
    }
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
    expect(link.getAttribute("href")).toBe(`/sessions?project=${encodeURIComponent("project 1/2")}`);
  });

  it("desktop: project name is plain text without a project_id", () => {
    const { utils } = setup();
    expect(screen.queryByRole("link", { name: "openkin" })).toBeNull();
    // The phone bar carries no project line any more (KIN-QUALITY-001, D16), so
    // the row is read from the desktop bar rather than from the whole screen.
    expect(within(desktopBar(utils)).getByText("openkin")).toBeTruthy();
  });

  it("phone: the trailing ⋯ button opens the action sheet via the passed-in onOpenActions callback", () => {
    const { props, utils } = setup({ phone: true });
    const more = phoneBar(utils).getByRole("button", { name: t("task.sessionActions") });
    fireEvent.click(more);
    expect(props.onOpenActions).toHaveBeenCalledTimes(1);
  });

  it("mac header: the project link is a 44x44 target", () => {
    // The link sat at 32.8x17.9 between 44x44 verbs, which the reading walk
    // reads as an unstable row (and a mouse-only target on a touch tablet).
    setup({ task: { ...task, project_id: "project-1" } });
    const link = screen.getByRole("link", { name: "openkin" });

    // Same accessible name and hit box; the destination is the narrowed list.
    expect(link.getAttribute("href")).toBe(`/sessions?project=${encodeURIComponent("project-1")}`);
    expect(link.getAttribute("title")).toBe("openkin");
    const classes = link.className.split(/\s+/);
    expect(classes).toContain("min-h-11");
    expect(classes).toContain("min-w-11");
    expect(classes).toContain("inline-flex");
    // The ellipsis has to happen inside the box, so a long project cannot
    // stretch it past the row's 44 px height or its max width.
    expect(link.querySelector("span")?.className.split(/\s+/)).toContain("truncate");
  });

  it("phone: leaves the live state to the composer, not a header pill", () => {
    const { utils } = setup({ phone: true });
    const phone = phoneBarEl(utils);

    expect(statusPill(phone)).toBeNull();
    expect(phoneBar(utils).queryByText(t("task.running"))).toBeNull();
  });

  it("phone: keeps one text line — the title and no project row", () => {
    const { utils } = setup({
      phone: true,
      task: { ...task, workspace_branch: "rsi/header-pill" },
    });
    const phone = phoneBarEl(utils);
    const title = phone.querySelector("h1") as HTMLElement;

    expect(title.textContent).toBe("Fix the header");
    expect(title.className.split(/\s+/)).toContain("truncate");

    // The project and branch left the bar with the second line; the bar is
    // one 44 px row (KIN-QUALITY-001, D16), so their absence is the contract.
    expect(phone.textContent).not.toContain("openkin");
    expect(phone.textContent).not.toContain("rsi/header-pill");
    expect(statusPill(phone)).toBeNull();
  });

  it("phone: hides the status pill once the turn is terminal", () => {
    const { utils } = setup({ phone: true, terminal: true });
    const phone = phoneBarEl(utils);

    expect(statusPill(phone)).toBeNull();
    expect(phoneBar(utils).queryByText(t("task.running"))).toBeNull();
  });

  it("phone: leaves the degraded state to the shell's reconnect strip", () => {
    // The bar carries no live-state pill any more; the shell's strip above the
    // page is what says the stream is degraded (AppShell, reconnectBanner).
    const { utils } = setup({ phone: true, degraded: true });
    const phone = phoneBarEl(utils);

    expect(statusPill(phone)).toBeNull();
    expect(phoneBar(utils).queryByText(t("task.reconnect"))).toBeNull();
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

  it("desktop: the PR toggle reports its pressed state and calls the page", () => {
    // The button is a peer of the workspace toggle, not a mode of it: the two
    // panels are separate surfaces and each says whether it is the one open.
    const { props, utils } = setup({ prOpen: true });
    const toggle = within(desktopBar(utils)).getByRole("button", { name: t("pr.title") });

    expect(toggle.getAttribute("aria-pressed")).toBe("true");
    fireEvent.click(toggle);
    expect(props.onTogglePr).toHaveBeenCalledTimes(1);
    expect(props.onToggleWorkspace).not.toHaveBeenCalled();
    utils.unmount();

    setup({ prOpen: false });
    expect(screen.getByRole("button", { name: t("pr.title") }).getAttribute("aria-pressed")).toBe(
      "false",
    );
  });

  it("keeps the phone bar unchanged", () => {
    // The phone has no list column: its list is the page, and a control that
    // reveals a column it does not have is the phone control TASTE 3 forbids
    // on the Mac surface (and vice versa).
    const { utils } = setup({ phone: true, panelOpen: true });
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

  it("shows the running subagent count beside the status", () => {
    // The count is a merge into the live-state area the header already owns:
    // no button, no panel, no per-subagent stop. It sits immediately before
    // the pill on the desktop cluster; the phone bar is one line and has no
    // room for it, so the count is desktop-only there, never a new line.
    const label = t("task.subagentCount", { count: 2 });
    const plain = setup();
    const buttonsBefore = screen.queryAllByRole("button").length;
    plain.utils.unmount();

    const { utils } = setup({ subagentsRunning: 2 });
    const desktop = desktopBar(utils);
    const desktopCount = within(desktop).getByText(label);
    expect(desktopCount.closest("button")).toBeNull();
    expect(desktopCount.getAttribute("tabindex")).toBeNull();
    expect(desktopCount.nextElementSibling).toBe(statusPill(desktop));
    // A count is not a control: the header's set of buttons did not grow.
    expect(screen.queryAllByRole("button").length).toBe(buttonsBefore);
    utils.unmount();

    // One bar per width: the phone bar is one 44 px row, so the count stays on
    // the desktop cluster and never becomes a second line on a phone.
    const { utils: phoneUtils } = setup({ phone: true, subagentsRunning: 2 });
    const phone = phoneBarEl(phoneUtils);
    expect(within(phone).queryByText(label)).toBeNull();
  });

  it("hides the count at zero and when the turn is terminal", () => {
    // Zero is the empty state — absent, not "Subagents: 0" — and a finished
    // turn has no live state left for a count to describe.
    const zero = setup({ subagentsRunning: 0 });
    expect(screen.queryByText(t("task.subagentCount", { count: 0 }))).toBeNull();
    zero.utils.unmount();

    setup({ subagentsRunning: 3, terminal: true });
    expect(screen.queryByText(t("task.subagentCount", { count: 3 }))).toBeNull();
  });
});
