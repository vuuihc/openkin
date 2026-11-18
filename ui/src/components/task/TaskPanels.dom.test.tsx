// @vitest-environment jsdom
import { fireEvent, render, screen, within } from "@testing-library/react";
import { describe, expect, it, vi } from "vitest";
import { MemoryRouter } from "react-router-dom";
import type { Task, TaskEvent, TaskUsage } from "../../api/client";
import type { ChangedFile } from "../../lib/changedFiles";
import type { PanelContext } from "../../lib/panels";
import type { PublishDraft } from "../../lib/publishDraft";
import { t } from "../../i18n";
import TaskPanels, { type TaskPanelsProps } from "./TaskPanels";

// The viewer is the only thing that loads monaco, which jsdom cannot resolve.
// This suite is about which surface renders and where its handlers point, not
// about what draws a file.
vi.mock("../workspace/CodeViewer", () => ({
  default: () => null,
}));

// WorkspacePanel reads its generations, tree and diff on mount. None of that is
// the subject here; the panel's own suite covers it. Answering with empty
// results keeps the surfaces rendered without a network.
vi.mock("../../api/client", async () => {
  const actual = await vi.importActual<typeof import("../../api/client")>("../../api/client");
  return {
    ...actual,
    listTaskWorkspaces: () => Promise.resolve([]),
    listTaskSourceTree: () => Promise.resolve({ path: ".", entries: [] }),
    listWorkspaceTree: () => Promise.resolve({ path: ".", entries: [] }),
    getTaskSourceChanges: () => Promise.resolve({ changes: [] }),
    getWorkspaceDiff: () => Promise.resolve({ files: [] }),
    // The pull-request panel reads its branch on mount. Nothing has been
    // observed here; a failed read is not the subject of this suite, so it
    // resolves an empty snapshot without asking GitHub.
    getTaskPullRequest: () => Promise.resolve({ gh: { available: true }, observations: [] }),
    refreshTaskPullRequest: () => Promise.resolve({ gh: { available: true }, observations: [] }),
  };
});

Element.prototype.scrollIntoView = vi.fn();

/**
 * The session's floating surfaces, extracted from `TaskDetailPage`. The pull
 * request is the workspace panel's third tab now, not a surface beside it.
 *
 * What is pinned here is the contract the extraction must not blur: the page
 * owns state and handlers, this component only decides which surface is open
 * and passes the page's callbacks straight through. The rail is always there
 * (CSS hides it below 1600px); the files surface and the publish sheet are
 * mutually exclusive, and publish additionally needs a machine to publish to.
 */

const task: Task = {
  id: "task-1",
  title: "Fix the panels",
  agent: "kin",
  cwd: "/tmp/example",
  prompt: "Fix the panels",
  status: "running",
  tokens_in: 0,
  tokens_out: 0,
  created_at: 1_700_000_000_000,
  event_epoch: 0,
};

const remoteMachine = { text: "node-1", known: true };

const draft: PublishDraft = { title: "Fix the panels", body: "Body" };

const localCtx: PanelContext = { taskId: task.id, remote: false, desktop: false };
const remoteCtx: PanelContext = { taskId: task.id, remote: true, desktop: false };

function setup(overrides: Partial<TaskPanelsProps> = {}) {
  const props: TaskPanelsProps = {
    task,
    machine: null,
    panel: null,
    panelCtx: localCtx,
    usage: null as TaskUsage | null,
    usageLoading: false,
    events: [] as TaskEvent[],
    changedFiles: [] as ChangedFile[],
    reviewBusy: false,
    terminal: false,
    workspaceOpenPath: null,
    workspaceOpenNonce: 0,
    selectedWorkspaceId: null,
    onSelectWorkspace: vi.fn(),
    onOpenPath: vi.fn(),
    onOpenFilesPanel: vi.fn(),
    onOpenPr: vi.fn(),
    onShowFiles: vi.fn(),
    onKeepAll: vi.fn(),
    onDiscardAll: vi.fn(),
    onPublish: vi.fn(),
    onFindFile: vi.fn(),
    onClosePanel: vi.fn(),
    publishDraft: draft,
    onPublishRowChanged: vi.fn(),
    ...overrides,
  };
  const utils = render(
    <MemoryRouter>
      <TaskPanels {...props} />
    </MemoryRouter>,
  );
  return { props, utils };
}

describe("TaskPanels", () => {
  it("renders the session rail when no panel is open", () => {
    setup();
    // The rail is the only landmark: no panel surface draws over the chat.
    const regions = screen.getAllByRole("complementary");
    expect(regions).toHaveLength(1);
    expect(regions[0].getAttribute("aria-label")).toBe(t("task.sessionRail"));
  });

  it("renders the workspace surface under its translated title", () => {
    setup({ panel: "files" });
    expect(screen.getByRole("complementary", { name: t("workspace.title") })).toBeTruthy();
  });

  it("renders no publish surface without a machine", () => {
    setup({ panel: "publish", machine: null });
    expect(screen.queryByText(t("publish.title"))).toBeNull();
    // Only the rail's landmark remains: no surface opened in its place.
    expect(screen.queryByRole("complementary", { name: t("publish.title") })).toBeNull();
    expect(screen.queryByRole("complementary", { name: t("workspace.title") })).toBeNull();
  });

  it("renders the publish surface for a remote machine", () => {
    setup({ panel: "publish", machine: remoteMachine });
    expect(screen.getByRole("complementary", { name: t("publish.title") })).toBeTruthy();
  });

  it("offers publish from the workspace panel only when the registry allows it", () => {
    setup({ panel: "files", panelCtx: localCtx });
    expect(screen.queryByRole("button", { name: t("publish.action") })).toBeNull();
  });

  it("offers publish from the workspace panel for a remote session", () => {
    const { props } = setup({ panel: "files", panelCtx: remoteCtx, machine: remoteMachine });
    fireEvent.click(screen.getByRole("button", { name: t("publish.action") }));
    expect(props.onPublish).toHaveBeenCalledTimes(1);
  });

  it("renders the pull request surface under its translated title", async () => {
    const { utils } = setup({ panel: "pr" });
    expect(await screen.findByRole("complementary", { name: t("pr.title") })).toBeTruthy();
    utils.unmount();

    // It is the same one-surface rule as the other panels: nothing open means
    // no PR surface anywhere.
    setup({ panel: null });
    expect(screen.queryByRole("complementary", { name: t("pr.title") })).toBeNull();
    expect(screen.queryByText(t("pr.title"))).toBeNull();
  });

  it("renders the pull request body inside the workspace container, not a second surface", () => {
    setup({ panel: "pr" });

    // One container, named for the surface in front: the PR is a tab of the
    // workspace panel, not a sheet of its own.
    const regions = screen.getAllByRole("complementary");
    expect(regions).toHaveLength(1);
    expect(regions[0]!.getAttribute("aria-label")).toBe(t("pr.title"));

    // …and the panel's one tab strip lives inside it, with PR selected.
    const strip = within(regions[0]!).getByRole("tablist");
    expect(within(strip).getAllByRole("tab")).toHaveLength(3);
    expect(
      within(strip).getByRole("tab", { name: t("pr.title") }).getAttribute("aria-selected"),
    ).toBe("true");
  });

  it("names the container by the surface in front", () => {
    const pr = setup({ panel: "pr" });
    expect(screen.getByRole("complementary", { name: t("pr.title") })).toBeTruthy();
    expect(screen.queryByRole("complementary", { name: t("workspace.title") })).toBeNull();
    pr.utils.unmount();

    setup({ panel: "files" });
    expect(screen.getByRole("complementary", { name: t("workspace.title") })).toBeTruthy();
    expect(screen.queryByRole("complementary", { name: t("pr.title") })).toBeNull();
  });

  it("closes the PR surface through the container's one close button", () => {
    const { props } = setup({ panel: "pr" });

    // The container owns the close. The PR body draws no second one, so the
    // label the reader gets is the PR's own.
    const closes = screen.getAllByRole("button", { name: t("pr.close") });
    expect(closes).toHaveLength(1);
    fireEvent.click(closes[0]!);
    expect(props.onClosePanel).toHaveBeenCalledTimes(1);
  });

  it("forwards the page's close to the open surface", () => {
    const { props } = setup({ panel: "files" });
    fireEvent.click(screen.getByRole("button", { name: t("workspace.close") }));
    expect(props.onClosePanel).toHaveBeenCalledTimes(1);
  });
});
