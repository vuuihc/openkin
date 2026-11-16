import type { Task, TaskEvent, TaskUsage } from "../../api/client";
import type { ChangedFile } from "../../lib/changedFiles";
import { isPanelAvailable, type PanelContext, type PanelId } from "../../lib/panels";
import type { PublishDraft } from "../../lib/publishDraft";
import { useT } from "../../i18n/react";
import PanelSurface from "../layout/PanelSurface";
import PublishPanel from "../pr/PublishPanel";
import ChangedFilesBar from "../workspace/ChangedFilesBar";
import WorkspacePanel from "../workspace/WorkspacePanel";
import TaskUsageSummary from "../usage/TaskUsageSummary";

/**
 * The session's floating surfaces: the side rail, the files panel and the
 * publish sheet.
 *
 * Extracted from `TaskDetailPage` unchanged so the page's state, handlers and
 * lifecycle logic can be read — and later edited — without scrolling past the
 * markup of three surfaces that only draw what the page tells them. It reads no
 * store and fetches nothing: every value and callback below is the page's.
 *
 * The component renders a fragment, never a wrapper. The rail is `absolute` and
 * `PanelSurface` is `absolute inset-0`, so both position against the page's
 * `relative` container; a positioned element here would move them.
 */
export type TaskPanelsProps = {
  task: Task;
  /** The machine the session runs on, or null when it runs on this one. */
  machine: { text: string; known: boolean } | null;
  /** The panel the page resolved for this view, if any. */
  panel: PanelId | null;
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
  selectedWorkspaceId: string | null | undefined;
  onSelectWorkspace: (id: string | null) => void;
  onOpenPath: (path: string) => void;
  onOpenFilesPanel: () => void;
  onKeepAll: () => void | Promise<void>;
  onDiscardAll: () => void | Promise<void>;
  onPublish: () => void;
  onFindFile: () => void;
  onClosePanel: () => void;
  /** The agent's last answer, as the publish sheet's opening draft. */
  publishDraft: PublishDraft;
  onPublishRowChanged: () => void;
};

export default function TaskPanels({
  task,
  machine,
  panel,
  panelCtx,
  usage,
  usageLoading,
  events,
  changedFiles,
  reviewBusy,
  terminal,
  workspaceOpenPath,
  workspaceOpenNonce,
  selectedWorkspaceId,
  onSelectWorkspace,
  onOpenPath,
  onOpenFilesPanel,
  onKeepAll,
  onDiscardAll,
  onPublish,
  onFindFile,
  onClosePanel,
  publishDraft,
  onPublishRowChanged,
}: TaskPanelsProps) {
  const tr = useT();
  const filesOpen = panel === "files";
  const publishOpen = panel === "publish";

  return (
    <>
      {/* Session side rail — usage + diffs, floats over the chat instead of squeezing its width (Codex-style). */}
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

      {filesOpen && (
        <PanelSurface label={tr("workspace.title")}>
          <div className="h-full w-full">
            <WorkspacePanel
              taskId={task.id}
              cwd={task.cwd}
              openPath={workspaceOpenPath}
              openNonce={workspaceOpenNonce}
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
              // button that could only ever be refused is worse than no button.
              // Asked of the registry rather than of `machine`, so the rule has
              // one home — the same one `resolvePanel` just consulted.
              onPublish={isPanelAvailable("publish", panelCtx) ? onPublish : undefined}
              onFindFile={onFindFile}
              onClose={onClosePanel}
            />
          </div>
        </PanelSurface>
      )}

      {publishOpen && machine && (
        <PublishPanel
          taskId={task.id}
          machine={machine}
          // Where the Hub remembers the work being. It is what the machine
          // recorded when the session started (or the last publish corrected),
          // and the sheet says "unknown" rather than guessing when there is
          // nothing: only that machine can answer, and it answers when asked.
          repo={task.workspace_repo ?? undefined}
          branch={task.workspace_branch ?? undefined}
          draft={publishDraft}
          // Both answers that change the Hub's row — a publish, and the escape
          // that moves the checkout — land here, so the row under this page is
          // read again. The row is what the sheet opens with and what the
          // repository chip draws; the branch strip beside it asks the machine
          // on its own and is not this.
          onRowChanged={onPublishRowChanged}
          onClose={onClosePanel}
        />
      )}
    </>
  );
}
