import type { Task, TaskEvent, TaskUsage } from "../../api/client";
import type { ChangedFile } from "../../lib/changedFiles";
import { isPanelAvailable, type PanelContext, type PanelId } from "../../lib/panels";
import type { PublishDraft } from "../../lib/publishDraft";
import { useT } from "../../i18n/react";
import PanelSurface from "../layout/PanelSurface";
import PublishPanel from "../pr/PublishPanel";
import PullRequestPanel from "../pr/PullRequestPanel";
import ChangedFilesBar from "../workspace/ChangedFilesBar";
import WorkspacePanel from "../workspace/WorkspacePanel";
import TaskUsageSummary from "../usage/TaskUsageSummary";

/**
 * The session's floating surfaces: the side rail and the workspace panel — the
 * files lenses, with the read-only pull request and publish as its third and
 * fourth tabs.
 *
 * Extracted from `TaskDetailPage` unchanged so the page's state, handlers and
 * lifecycle logic can be read — and later edited — without scrolling past the
 * markup of two surfaces that only draw what the page tells them. It reads no
 * store and fetches nothing: every value and callback below is the page's.
 *
 * The component renders a fragment, never a wrapper. Both surfaces position
 * against the page's `relative` container: the rail is `absolute` over the
 * chat, and `PanelSurface` is the overlay below `lg` and an in-flow 380px
 * column (the page's row is `lg:flex-row`) from `lg` up. A positioned wrapper
 * here would move them.
 */
export type TaskPanelsProps = {
  task: Task;
  /** The machine the session runs on, or null when it runs on this one. */
  machine: { text: string; known: boolean } | null;
  /** The panel the page resolved for this view, if any. */
  panel: PanelId | null;
  /**
   * Whether this session's pane is the one on screen. The host keeps recent
   * panes mounted and hides the rest, so a panel can be open and invisible.
   */
  active?: boolean;
  /** What the panel registry was asked about — publish's gate is read from it. */
  panelCtx: PanelContext;
  usage: TaskUsage | null;
  usageLoading: boolean;
  /** Task event stream, for the workspace panel's diff reconstruction. */
  events: TaskEvent[];
  changedFiles: ChangedFile[];
  /** A keep/discard bulk action is in flight. */
  reviewBusy: boolean;
  /** The session's turn has ended; keep/discard review actions apply. */
  terminal: boolean;
  workspaceOpenPath: string | null;
  workspaceOpenNonce: number;
  /** Bumps when an applied link says the list: the panel leaves its file. */
  workspaceShowListNonce?: number;
  selectedWorkspaceId: string | null | undefined;
  onSelectWorkspace: (id: string | null) => void;
  onOpenPath: (path: string) => void;
  /** A file picked inside the panel; the page writes the address. */
  onPanelSelectPath?: (path: string) => void;
  onOpenFilesPanel: () => void;
  /**
   * The workspace panel's PR tab was picked. The page owns the address, so the
   * tab asks for the surface instead of flipping anything here.
   */
  onOpenPr: () => void;
  /**
   * A lens tab was picked while the PR tab was in front: the page returns the
   * panel to its files surface and keeps the remembered file and lens.
   */
  onShowFiles: () => void;
  onKeepAll: () => void | Promise<void>;
  onDiscardAll: () => void | Promise<void>;
  onPublish: () => void;
  onFindFile: () => void;
  /**
   * Send one ordinary follow-up message into this conversation. The page owns
   * the send path; the workspace's diff comments go back through it so a
   * comment costs exactly one message, queued like any other.
   */
  onSendFollowUp?: (text: string) => Promise<void>;
  onClosePanel: () => void;
  /** The agent's last answer, as the publish tab's opening draft. */
  publishDraft: PublishDraft;
  onPublishRowChanged: () => void;
};

export default function TaskPanels({
  task,
  machine,
  panel,
  active = true,
  panelCtx,
  usage,
  usageLoading,
  events,
  changedFiles,
  reviewBusy,
  terminal,
  workspaceOpenPath,
  workspaceOpenNonce,
  workspaceShowListNonce,
  selectedWorkspaceId,
  onSelectWorkspace,
  onOpenPath,
  onPanelSelectPath,
  onOpenFilesPanel,
  onOpenPr,
  onShowFiles,
  onKeepAll,
  onDiscardAll,
  onPublish,
  onFindFile,
  onSendFollowUp,
  onClosePanel,
  publishDraft,
  onPublishRowChanged,
}: TaskPanelsProps) {
  const tr = useT();
  const filesOpen = panel === "files";
  const prOpen = panel === "pr";
  // One predicate for the tab and the pane: the registry's rule (a checkout on
  // another machine) and a machine to publish to. Two answers could disagree —
  // a tab that opens nothing, or a surface with no tab selected — so there is
  // only one.
  const publishOffered = machine !== null && isPanelAvailable("publish", panelCtx);
  const publishOpen = panel === "publish" && publishOffered;

  return (
    <>
      {/* Session side rail — usage + diffs, floats over the chat instead of squeezing its width (Codex-style).

          It yields to an open panel. The rail is anchored to the page's right
          edge, which from `lg` up is where the panel column now sits: leaving
          both would float the rail over the panel's own close button, and the
          panel already shows the changed files the rail repeats. */}
      {panel === null && (
        <aside
          className="hidden min-[1600px]:flex absolute top-14 right-3 bottom-3 z-10 w-inspector-rail flex-col gap-2.5 rounded-xl bg-[var(--kin-inspector)] backdrop-blur-md shadow-e2 px-3 py-3 min-h-0 overflow-y-auto kin-scroll"
          aria-label={tr("task.sessionRail")}
        >
          <TaskUsageSummary usage={usage} loading={usageLoading} variant="card" />
          <ChangedFilesBar
            files={changedFiles}
            onOpenPath={onOpenPath}
            onOpenPanel={onOpenFilesPanel}
            reviewActions={terminal}
            onKeepAll={onKeepAll}
            onDiscardAll={onDiscardAll}
            actionsBusy={reviewBusy}
            variant="card"
          />
        </aside>
      )}

      {(filesOpen || prOpen || publishOpen) && (
        <PanelSurface
          label={
            prOpen ? tr("pr.title") : publishOpen ? tr("publish.title") : tr("workspace.title")
          }
          shape="column"
        >
          <div className="h-full w-full">
            <WorkspacePanel
              taskId={task.id}
              cwd={task.cwd}
              openPath={workspaceOpenPath}
              openNonce={workspaceOpenNonce}
              showListNonce={workspaceShowListNonce}
              onSelectPath={onPanelSelectPath}
              events={events}
              changedFiles={changedFiles}
              selectedWorkspaceId={selectedWorkspaceId}
              currentWorkspaceId={task.current_workspace_id}
              onSelectWorkspace={onSelectWorkspace}
              reviewActions={terminal}
              onDiscardAll={onDiscardAll}
              actionsBusy={reviewBusy}
              // Publishing is offered for a session on another machine and no
              // other: the Hub refuses the write for a checkout it holds, and a
              // tab that could only ever be refused is worse than no tab. The
              // predicate is shared with the pane above, so the tab and the
              // surface cannot disagree — the same rule `resolvePanel` just
              // consulted.
              onOpenPublish={publishOffered ? onPublish : undefined}
              onFindFile={onFindFile}
              onSendFollowUp={onSendFollowUp}
              onClose={onClosePanel}
              // The PR and publish are this panel's third and fourth tabs,
              // drawn by the same container and the same strip. The page still
              // owns the surface address, which is why a tab asks rather than
              // flipping anything here.
              surface={prOpen ? "pr" : publishOpen ? "publish" : "files"}
              prPane={
                prOpen ? (
                  <PullRequestPanel
                    taskId={task.id}
                    active={active}
                    // The machine holding the checkout, when that is not this
                    // one: it is what the panel falls back to before anything
                    // has been read, and what tells it a branchless task
                    // still has something to ask about.
                    elsewhere={machine}
                    onClose={onClosePanel}
                    embedded
                  />
                ) : undefined
              }
              publishPane={
                publishOpen ? (
                  <PublishPanel
                    taskId={task.id}
                    machine={machine}
                    // Where the Hub remembers the work being. It is what the
                    // machine recorded when the session started (or the last
                    // publish corrected), and the pane says "unknown" rather
                    // than guessing when there is nothing: only that machine
                    // can answer, and it answers when asked.
                    repo={task.workspace_repo ?? undefined}
                    branch={task.workspace_branch ?? undefined}
                    draft={publishDraft}
                    // Both answers that change the Hub's row — a publish, and
                    // the escape that moves the checkout — land here, so the
                    // row under this page is read again. The row is what the
                    // pane opens with and what the repository chip draws; the
                    // branch strip beside it asks the machine on its own and is
                    // not this.
                    onRowChanged={onPublishRowChanged}
                    // The container owns the skin, the strip and the one close.
                    embedded
                  />
                ) : undefined
              }
              onOpenPr={onOpenPr}
              onShowFiles={onShowFiles}
            />
          </div>
        </PanelSurface>
      )}
    </>
  );
}
