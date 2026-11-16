import type { ComponentProps } from "react";
import type { AgentInfo, Task, TaskUsage, Upload } from "../../api/client";
import type { AgentRole } from "../../lib/agentRoles";
import { useMinWidth } from "../../hooks/useMinWidth";
import { useT } from "../../i18n/react";
import Composer from "../chat/Composer";
import RunConfigControl, { RunConfigSheetRow, type RunConfigAvatar } from "../chat/RunConfigSheet";
import BranchPicker from "../chat/BranchPicker";
import RepoChip from "../chat/RepoChip";
import CwdPicker from "../chat/CwdPicker";
import type PermissionModePicker from "../chat/PermissionModePicker";
import type ModelPicker from "../chat/ModelPicker";
import { IconAlert, IconMachine } from "../icons";
import Button from "../ui/Button";
import TaskUsageSummary from "../usage/TaskUsageSummary";

type ComposerProps = ComponentProps<typeof Composer>;
type PermissionPickerProps = ComponentProps<typeof PermissionModePicker>;
type ModelPickerProps = ComponentProps<typeof ModelPicker>;

/**
 * The conversation's bottom band: the waiting-on-you strip and the composer.
 * One run-config face — the chip that names the agent, the model and the
 * permission mode — rides on the composer's own control row at every width.
 * What the session is (folder, repository, branch, machine) is disclosed
 * inside the sheet or panel the chip opens, not as a second strip beside the
 * message.
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
  // `taskAgentModelSource` and `taskAgentModelStatus` stay on the props because
  // the page still supplies them; the run sheet's model row reads the catalog
  // itself and does not need the old strip's freshness hint.
  taskPermissionModes,
  transcriptModel,
  usage,
  usageLoading,
  machine,
  waitingCount,
  onRevealFirstPending,
}: TaskComposerDockProps) {
  const tr = useT();
  // The phone usage trigger opens a bottom sheet, so it must not exist at all
  // from `md` up: on a Mac the page's own usage bar already carries these
  // numbers, and a `md:hidden` class only hides the trigger while its sheet
  // stays in the tree. Unmount it instead.
  const wide = useMinWidth(768);

  return (
    <div
      data-kin-bottom-chrome={active ? "" : undefined}
      className="flex-none px-4 sm:px-7 pb-3 sm:pb-3.5 pt-1.5"
    >
      <div className="max-w-conversation mx-auto space-y-1.5">
        {waitingCount > 0 && (
          <Button
            variant="secondary"
            aria-label={tr("task.waitingOnYou", { count: String(waitingCount) })}
            onClick={onRevealFirstPending}
            className="w-full justify-center gap-1.5 rounded-xl border-kin-orange/40 bg-kin-orange/15 px-3 py-2 text-subtitle font-medium text-kin-orange-ink hover:bg-kin-orange/15"
          >
            <IconAlert className="w-4 h-4 flex-none" />
            {tr("task.waitingOnYou", { count: String(waitingCount) })}
          </Button>
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
          // One run-config entry at every width, on the composer's own control
          // row. The chip names the three settings that affect the next
          // message; the sheet or panel it opens owns them and the facts that
          // describe the session (folder, repository, branch, machine). A
          // second strip of controls beside the message was the crowded edge
          // of this card, and the door closes with the pane it belongs to.
          footerWide
          footer={
            active ? (
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
                  extraRows={
                    <>
                      {/* The agent is the sheet's own locked row (no `agents`
                          prop), so it is not repeated here. Where the work is:
                          a session on this machine has no recorded repository
                          and shows no row — its repository is the one the
                          pull-request panel looked up. */}
                      <RunConfigSheetRow
                        label={tr("newChat.rowCwd")}
                        control={
                          <CwdPicker cwd={task.cwd} locked compact onChange={() => undefined} />
                        }
                      />
                      {task.workspace_repo ? (
                        <RunConfigSheetRow
                          label={tr("pr.repoLabel")}
                          control={<RepoChip repo={task.workspace_repo} />}
                        />
                      ) : null}
                      <RunConfigSheetRow
                        label={tr("newChat.rowBranch")}
                        control={
                          <BranchPicker
                            cwd={task.cwd}
                            // The task's cwd is on the machine that runs it, so
                            // these branches are that machine's — not this
                            // one's, which for the same repository would read
                            // plausibly and be wrong.
                            device={task.executing_device_id}
                            locked
                            compact
                          />
                        }
                      />
                      {machine ? (
                        <RunConfigSheetRow
                          label={tr("newChat.rowMachine")}
                          control={
                            // Without this row the path above reads as a
                            // directory on the machine showing it.
                            <span
                              className="inline-flex min-w-0 items-center gap-1 text-caption text-kin-secondary"
                              title={tr("machine.remoteHint", { name: machine.text })}
                            >
                              <IconMachine size={12} className="flex-none" />
                              <span className="truncate">
                                {machine.known
                                  ? tr("machine.runsOn", { name: machine.text })
                                  : tr("machine.runsOnUnknown", { name: machine.text })}
                              </span>
                            </span>
                          }
                        />
                      ) : null}
                    </>
                  }
                />
                {!wide && !usageLoading && usage ? (
                  // The reference keeps usage at the input, and the phone has
                  // no usage bar above the transcript to read it from. The Mac
                  // reads the same numbers from the page's own usage bar.
                  <TaskUsageSummary
                    usage={usage}
                    loading={usageLoading}
                    variant="phone"
                    className="flex-none md:hidden"
                  />
                ) : null}
              </div>
            ) : null
          }
        />
      </div>
    </div>
  );
}
