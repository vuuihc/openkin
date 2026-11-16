import type { ComponentProps } from "react";
import type { AgentInfo, Task, TaskUsage, Upload } from "../../api/client";
import type { AgentRole } from "../../lib/agentRoles";
import { useT } from "../../i18n/react";
import Composer from "../chat/Composer";
import RunConfigControl, { type RunConfigAvatar } from "../chat/RunConfigSheet";
import BranchPicker from "../chat/BranchPicker";
import RepoChip from "../chat/RepoChip";
import CwdPicker from "../chat/CwdPicker";
import PermissionModePicker from "../chat/PermissionModePicker";
import ModelPicker from "../chat/ModelPicker";
import { IconAlert, IconMachine } from "../icons";
import TaskUsageSummary from "../usage/TaskUsageSummary";

type ComposerProps = ComponentProps<typeof Composer>;
type PermissionPickerProps = ComponentProps<typeof PermissionModePicker>;
type ModelPickerProps = ComponentProps<typeof ModelPicker>;

/**
 * The conversation's bottom band: the waiting-on-you strip, the composer with
 * its phone run-config face, and the `md`-up strip that names the agent, the
 * permission mode, the model, the directory, the repository, the branch and
 * the machine.
 *
 * Extracted from `TaskDetailPage` unchanged so the page's state, handlers and
 * lifecycle logic can be read — and later edited — without scrolling past the
 * markup of a band that only draws what the page tells it. It owns no state
 * and fetches nothing itself: every value and callback below is the page's.
 *
 * The outer div keeps `data-kin-bottom-chrome`, a contract with the shell's
 * floating surfaces: this band is everything the page pins to the bottom, so
 * an overlay that has to stay clear of it measures this instead of guessing a
 * height. Only the pane on screen marks itself — the session host keeps cached
 * conversations mounted but hidden, and their bands have no box to measure.
 * See FloatingApproval.
 */
export type TaskComposerDockProps = {
  /** Whether this pane is the one on screen; hides the bottom-chrome marker otherwise. */
  active: boolean;
  task: Task;
  /** The session's turn has ended; the composer asks for a follow-up instead of queueing. */
  terminal: boolean;
  /** The task detail has loaded; until then the composer cannot send. */
  detailLoaded: boolean;
  agents: AgentInfo[];
  agentRoles: readonly AgentRole[] | null;
  hostAgentName: string;
  hostAgentAvatar: RunConfigAvatar;
  sending: boolean;
  stopping: boolean;
  initialValue: string;
  initialAttachments: Upload[];
  focusSignal: number;
  fileSearch?: ComposerProps["fileSearch"];
  onValueChange: (value: string) => void;
  onAttachmentsChange: (attachments: Upload[]) => void;
  onSubmit: ComposerProps["onSubmit"];
  onStop: NonNullable<ComposerProps["onStop"]>;
  composerModel: ModelPickerProps["value"];
  onComposerModelChange: ModelPickerProps["onChange"];
  composerPermissionMode: PermissionPickerProps["value"];
  onComposerPermissionChange: PermissionPickerProps["onChange"];
  taskAgentModels: ModelPickerProps["models"];
  taskAgentModelSource?: ModelPickerProps["source"];
  taskAgentModelStatus?: ModelPickerProps["status"];
  taskPermissionModes: NonNullable<PermissionPickerProps["modes"]>;
  /** The model the transcript reports, named when no explicit model is set. */
  transcriptModel?: string;
  usage: TaskUsage | null;
  usageLoading: boolean;
  /** The machine the session runs on, or null when it runs on this one. */
  machine: { text: string; known: boolean } | null;
  /** How many approvals or questions are waiting on the person. */
  waitingCount: number;
  onRevealFirstPending: () => void;
};

export default function TaskComposerDock({
  active,
  task,
  terminal,
  detailLoaded,
  agents,
  agentRoles,
  hostAgentName,
  hostAgentAvatar,
  sending,
  stopping,
  initialValue,
  initialAttachments,
  focusSignal,
  fileSearch,
  onValueChange,
  onAttachmentsChange,
  onSubmit,
  onStop,
  composerModel,
  onComposerModelChange,
  composerPermissionMode,
  onComposerPermissionChange,
  taskAgentModels,
  taskAgentModelSource,
  taskAgentModelStatus,
  taskPermissionModes,
  transcriptModel,
  usage,
  usageLoading,
  machine,
  waitingCount,
  onRevealFirstPending,
}: TaskComposerDockProps) {
  const tr = useT();

  return (
    <div
      data-kin-bottom-chrome={active ? "" : undefined}
      className="flex-none px-4 sm:px-7 pb-3 sm:pb-3.5 pt-1.5"
    >
      <div className="max-w-conversation mx-auto space-y-1.5">
        {waitingCount > 0 && (
          /* eslint-disable-next-line kin/no-raw-button -- moved unchanged from TaskDetailPage; the full-width callout band is not one of the shared Button's three weights. */
          <button
            type="button"
            onClick={onRevealFirstPending}
            className="w-full flex items-center justify-center gap-1.5 rounded-xl border border-kin-orange/40 bg-kin-orange/15 px-3 py-2 text-subtitle font-medium text-kin-orange-ink outline-none focus-visible:ring-2 focus-visible:ring-kin-focus-ring"
          >
            <IconAlert className="w-4 h-4 flex-none" />
            {tr("task.waitingOnYou", { count: String(waitingCount) })}
          </button>
        )}
        <Composer
          key={task.id}
          agents={agents}
          roles={agentRoles}
          hostAgentId={task.agent || ""}
          fileSearch={fileSearch}
          busy={sending}
          running={!terminal}
          stopping={stopping}
          disabled={sending || stopping || !detailLoaded}
          initialValue={initialValue}
          initialAttachments={initialAttachments}
          focusSignal={focusSignal}
          placeholder={
            !terminal
              ? tr("composer.queuedWhileRunning")
              : tr("composer.followUpPlaceholder", { name: hostAgentName })
          }
          onValueChange={onValueChange}
          onAttachmentsChange={onAttachmentsChange}
          onSubmit={onSubmit}
          onStop={onStop}
          footer={
            // One control instead of a strip of chips: the face names the
            // agent, the model and the mode, and the sheet behind it owns
            // the two that can change. Desktop keeps the strip below. The
            // usage trigger rides beside it — the reference keeps usage at
            // the input, and the phone has no usage bar above the
            // transcript to read it from.
            <div className="flex min-w-0 flex-1 items-center gap-1">
              <RunConfigControl
                agentName={hostAgentName}
                agentId={task.agent || ""}
                agentAvatar={hostAgentAvatar}
                model={composerModel}
                models={taskAgentModels}
                onModelChange={onComposerModelChange}
                permission={composerPermissionMode}
                permissionModes={taskPermissionModes}
                onPermissionChange={onComposerPermissionChange}
                disabled={sending || stopping}
                fallbackModelLabel={transcriptModel}
              />
              {!usageLoading && usage ? (
                <TaskUsageSummary
                  usage={usage}
                  loading={usageLoading}
                  variant="phone"
                  className="flex-none"
                />
              ) : null}
            </div>
          }
        />
        {/* The desktop counterpart of the composer's run-config face: from
            `md` up this strip carries what the face carries (and the
            project, branch and machine beside it), and the face is hidden
            so the same two settings are not offered twice on one screen.
            One row, scrolled sideways when it does not fit — it has to
            overflow for that: an item allowed to shrink is squeezed to
            nothing first and paints its text over the chip next to it,
            which is what a long path next to a repository name did on a
            phone. */}
        <div className="hidden md:flex items-center gap-x-2 gap-y-1 px-0.5 min-w-0 overflow-x-auto kin-scroll whitespace-nowrap">
          {/* The host agent is this session's identity: the daemon has no
              protocol to swap it, so it is named as a fact rather than a
              disabled button. The phone's run sheet shows the same value
              the same way. */}
          <span
            className="inline-flex flex-none items-center gap-1.5 text-caption font-medium text-kin-secondary"
            title={tr("runConfig.agentLocked")}
          >
            <span
              className={`flex h-5 w-5 flex-none items-center justify-center rounded-md text-micro font-semibold ${hostAgentAvatar.className}`}
            >
              {hostAgentAvatar.initials}
            </span>
            <span className="max-w-[8rem] truncate">{hostAgentName}</span>
          </span>
          <span className="text-kin-muted/50 flex-none select-none" aria-hidden>
            ·
          </span>
          <PermissionModePicker
            value={composerPermissionMode}
            modes={taskPermissionModes}
            disabled={sending || stopping}
            compact
            active={active}
            onChange={onComposerPermissionChange}
          />
          <span className="text-kin-muted/50 flex-none select-none" aria-hidden>
            ·
          </span>
          <ModelPicker
            value={composerModel}
            models={taskAgentModels}
            source={taskAgentModelSource}
            status={taskAgentModelStatus}
            disabled={sending || stopping}
            compact
            fallbackDisplay={transcriptModel}
            onChange={onComposerModelChange}
          />
          {/* Where the work is — directory, repository, branch, machine —
              describes the session rather than changing the next message,
              and on a phone the four chips plus the two controls above do
              not fit one line. They stay on `md` up, where the row has the
              width; the project is named in the header and the machine in
              the session-actions sheet. A div, not a span: CwdPicker renders
              one, and a span may not contain it. */}
          <div className="hidden md:contents">
            <span className="text-kin-muted/50 flex-none select-none" aria-hidden>
              ·
            </span>
            <CwdPicker
              // The one item allowed to give way, because a path can be
              // arbitrarily long: it shrinks to a readable floor and its path
              // tag truncates inside that, rather than the row overflowing on
              // a desktop window or the chip collapsing on a phone.
              className="min-w-[6rem] max-w-inspector"
              cwd={task.cwd}
              locked
              compact
              onChange={() => undefined}
            />
            {/* Which repository the work is in. A session on this machine has
              no recorded one and shows nothing here — its repository is the
              one the pull-request panel looked up. A session on another
              machine has one, because the Hub asked that machine when the
              session started. */}
            <RepoChip repo={task.workspace_repo} />
            <BranchPicker
              cwd={task.cwd}
              // The task's cwd is on the machine that runs it, so the branches
              // in the strip below are that machine's — not this one's, which
              // for the same repository would read plausibly and be wrong.
              device={task.executing_device_id}
              locked
              compact
              className="flex-none"
            />
            {machine ? (
              <>
                <span className="text-kin-muted/50 flex-none select-none" aria-hidden>
                  ·
                </span>
                {/* Which machine the cwd above lives on. Without it the path in
                  this strip reads as a directory on the machine showing it. */}
                <span
                  className="flex-none inline-flex items-center gap-1 text-caption text-kin-secondary"
                  title={tr("machine.remoteHint", { name: machine.text })}
                >
                  <IconMachine size={12} />
                  {machine.known
                    ? tr("machine.runsOn", { name: machine.text })
                    : tr("machine.runsOnUnknown", { name: machine.text })}
                </span>
              </>
            ) : null}
          </div>
        </div>
      </div>
    </div>
  );
}
