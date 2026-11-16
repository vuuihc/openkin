// @vitest-environment jsdom
import { fireEvent, render, screen } from "@testing-library/react";
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
  };
});

Element.prototype.scrollIntoView = vi.fn();

/**
 * The session's three floating surfaces, extracted from `TaskDetailPage`.
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

  it("forwards the page's close to the open surface", () => {
    const { props } = setup({ panel: "files" });
    fireEvent.click(screen.getByRole("button", { name: t("workspace.close") }));
    expect(props.onClosePanel).toHaveBeenCalledTimes(1);
  });
});
