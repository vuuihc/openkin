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

describe("TaskHeader", () => {
  it("renders the phone header with the session title and a back button", () => {
    const { props, utils } = setup();
    const header = phoneBar(utils);
    expect(header.getByText("Fix the header")).toBeTruthy();

    const back = header.getByRole("button", { name: t("app.back") });
    fireEvent.click(back);
    expect(props.onBack).toHaveBeenCalledTimes(1);
  });

  it("renders the desktop header with the host chip, workspace, share, archive and delete buttons", () => {
    const { props } = setup();

    expect(screen.getByText(t("newChat.hostAgent", { name: "Kin" }))).toBeTruthy();

    const workspace = screen.getByRole("button", { name: t("workspace.title") });
    const share = screen.getByRole("button", { name: t("task.share") });
    const archive = screen.getByRole("button", { name: t("task.archiveSession") });
    const del = screen.getByRole("button", { name: t("task.deleteSession") });

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
    setup();
    expect(screen.queryByRole("link", { name: "openkin" })).toBeNull();
    expect(screen.getByText("openkin")).toBeTruthy();
  });

  it("phone: the trailing ⋯ button opens the action sheet via the passed-in onOpenActions callback", () => {
    const { props, utils } = setup();
    const more = phoneBar(utils).getByRole("button", { name: t("task.sessionActions") });
    fireEvent.click(more);
    expect(props.onOpenActions).toHaveBeenCalledTimes(1);
  });
});
