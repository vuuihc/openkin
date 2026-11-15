import type { RefObject } from "react";
import type { AgentInfo, AgentModelOption, Routine } from "../../api/client";
import CwdPicker from "../chat/CwdPicker";
import ModelPicker from "../chat/ModelPicker";
import PermissionModePicker from "../chat/PermissionModePicker";
import SheetSelect from "../ui/SheetSelect";
import type { ConversationMode } from "../../lib/routineConversation";
import type { PermissionMode } from "../../lib/permissionMode";
import type { RoutineRule } from "../../lib/routineRecurrence";
import { useT } from "../../i18n/react";
import RoutineScheduleFields from "./RoutineScheduleFields";

export type FormDraft = {
  title: string;
  prompt: string;
  cwd: string;
  agentId: string;
  model: string;
  permissionMode: PermissionMode;
  conversationMode: ConversationMode;
  intervalSecs: number;
  rule: RoutineRule | null;
  ruleZone: string | null;
  nextRunLocal: string;
};

export type RoutineEditorProps = {
  value: FormDraft;
  editing: Routine | null;
  /** One patch per user edit, applied by the page's form state. */
  onChange: (patch: Partial<FormDraft>) => void;
  onSubmit: () => void;
  onCancel: () => void;
  /** A save is in flight: Escape and Cancel are held. */
  creating: boolean;
  /** creating || machineOffline: every field and Save is held. */
  formLocked: boolean;
  agents: AgentInfo[];
  models: AgentModelOption[];
  modelSource?: AgentInfo["model_list_source"];
  modelStatus?: AgentInfo["model_list_status"];
  deviceId: string;
  nextRunPreview?: number | null;
  conversationHint: string;
  titleRef: RefObject<HTMLInputElement>;
  sectionRef: RefObject<HTMLElement>;
};

export default function RoutineEditor({
  value,
  editing,
  onChange,
  onSubmit,
  onCancel,
  creating,
  formLocked,
  agents,
  models,
  modelSource,
  modelStatus,
  deviceId,
  nextRunPreview,
  conversationHint,
  titleRef,
  sectionRef,
}: RoutineEditorProps) {
  const tr = useT();
  const {
    title,
    prompt,
    cwd,
    agentId,
    model,
    permissionMode,
    conversationMode,
    intervalSecs,
    rule,
    ruleZone,
    nextRunLocal,
  } = value;

  return (
    <section
      id="routine-form"
      ref={sectionRef}
      aria-label={editing ? tr("routines.editPanelTitle") : tr("routines.createPanelTitle")}
      className="mt-5 scroll-mt-4 rounded-2xl border border-kin-blue/30 bg-kin-blue/5 p-4"
      onKeyDown={(e) => {
        // A sheet that is open handles its own Escape first and marks the
        // event handled; closing the form underneath it would strand the
        // picker.
        if (e.defaultPrevented) return;
        if (e.key === "Escape") {
          e.preventDefault();
          // A save in flight owns the form: closing it here would let the
          // completion close whatever form the reader opened meanwhile.
          // Offline is not a reason to refuse to close — closing is not
          // a write.
          if (!creating) onCancel();
          return;
        }
        if ((e.metaKey || e.ctrlKey) && e.key === "Enter") {
          e.preventDefault();
          // The same condition the Save button shows, so the shortcut
          // never sends something the visible control would refuse.
          if (!formLocked && prompt.trim() && cwd.trim()) onSubmit();
        }
      }}
    >
      <h2 className="text-strong font-medium text-kin-text">
        {editing ? tr("routines.editPanelTitle") : tr("routines.createPanelTitle")}
      </h2>
      <p className="mt-1 text-body text-kin-secondary">
        {editing ? tr("routines.editPanelHint") : tr("routines.createPanelHint")}
      </p>

      <label className="mt-4 block text-body text-kin-secondary">
        {tr("routines.titleLabel")}
        <input
          ref={titleRef}
          value={title}
          onChange={(e) => onChange({ title: e.target.value })}
          placeholder={tr("routines.titlePlaceholder")}
          disabled={formLocked}
          className="mt-1 w-full rounded-lg border border-[var(--kin-hairline)] bg-[var(--kin-fill)] px-3 py-2 text-strong text-kin-text outline-none focus:border-kin-blue/40"
        />
      </label>

      <label className="mt-3 block text-body text-kin-secondary">
        {tr("routines.promptLabel")}
        <textarea
          value={prompt}
          onChange={(e) => onChange({ prompt: e.target.value })}
          placeholder={tr("routines.promptPlaceholder")}
          rows={4}
          disabled={formLocked}
          className="mt-1 w-full resize-y rounded-xl border border-[var(--kin-hairline)] bg-kin-panel px-3 py-2.5 text-strong text-kin-text outline-none focus:border-kin-blue/40"
        />
      </label>

      <div className="mt-3 flex flex-wrap items-center gap-x-4 gap-y-2">
        <PermissionModePicker
          value={permissionMode}
          disabled={formLocked}
          onChange={(permissionMode) => onChange({ permissionMode })}
        />
        {agents.length > 0 && (
          <span className="inline-flex items-center gap-2 text-body text-kin-secondary">
            <span className="text-kin-muted">{tr("routines.agentLabel")}</span>
            <SheetSelect
              label={tr("routines.agentLabel")}
              value={agentId}
              disabled={formLocked}
              options={[
                /* A routine keeps the agent it was created with, even if
                   that agent is offline right now. Without this row the
                   control would show the first available agent while the
                   state still held the missing id. */
                ...(agentId && agents.every((a) => a.id !== agentId)
                  ? [{ id: agentId, label: agentId }]
                  : []),
                ...agents.map((a) => ({ id: a.id, label: a.name })),
              ]}
              onChange={(agentId) => {
                // A model from the old agent's catalog is not one this
                // agent has; New Chat clears the same way on a host
                // change, and a stored id the agent does not know would
                // fail every run instead of falling back.
                onChange({ agentId, model: "" });
              }}
            />
          </span>
        )}
        {agentId && (
          <ModelPicker
            // The picker's own "Custom" state survives a value change by
            // design (picking Custom opens an empty input), so a model
            // cleared here would leave it reading "Custom" with a blank
            // box. Remounting on form identity and agent re-initialises
            // that state from the value the form now holds.
            key={`${editing?.id ?? "new"}:${agentId}`}
            value={model}
            models={models}
            source={modelSource}
            status={modelStatus}
            disabled={formLocked}
            onChange={(model) => onChange({ model })}
          />
        )}
      </div>

      <div className="mt-3">
        <CwdPicker
          className="w-full"
          cwd={cwd}
          locked={formLocked}
          // The cwd is a path on the machine the routine runs on. Without
          // this the panel would list this console's directories and the
          // saved path would be one that machine has never heard of.
          device={deviceId || undefined}
          onChange={(cwd) => onChange({ cwd })}
        />
      </div>

      <div className="mt-3 rounded-xl border border-[var(--kin-hairline)] bg-[var(--kin-fill)] px-3 py-2.5">
        <RoutineScheduleFields
          intervalSecs={intervalSecs}
          onIntervalChange={(intervalSecs) => onChange({ intervalSecs })}
          nextRunLocal={nextRunLocal}
          onNextRunLocalChange={(nextRunLocal) => onChange({ nextRunLocal })}
          rule={rule}
          onRuleChange={(rule) => onChange({ rule })}
          ruleZone={ruleZone}
          nextRunPreview={nextRunPreview}
          disabled={formLocked}
        />
      </div>

      <fieldset className="mt-3 rounded-xl border border-[var(--kin-hairline)] bg-[var(--kin-fill)] px-3 py-2.5">
        <legend className="px-1 text-caption font-semibold uppercase tracking-label text-kin-muted">
          {tr("routines.conversationLabel")}
        </legend>
        {(
          [
            ["continue", tr("routines.conversationContinue")],
            ["fresh", tr("routines.conversationFresh")],
          ] as const
        ).map(([mode, label]) => (
          <label
            key={mode}
            className="flex min-h-11 items-center gap-2 text-body text-kin-text md:min-h-8"
          >
            <input
              type="radio"
              name="routine-conversation"
              value={mode}
              checked={conversationMode === mode}
              disabled={formLocked}
              onChange={() => onChange({ conversationMode: mode })}
              className="h-4 w-4 accent-kin-blue"
            />
            <span>{label}</span>
          </label>
        ))}
        <p className="mt-1 text-caption leading-5 text-kin-muted">{conversationHint}</p>
      </fieldset>

      <div className="mt-4 flex justify-end gap-2">
        {/* eslint-disable-next-line kin/no-raw-button -- moved unchanged from
            RoutinesPage; this slice adds no shared button primitive. */}
        <button
          type="button"
          // Only a save in flight blocks closing; an offline machine is
          // a reason to disable writes, not the way out of the form.
          disabled={creating}
          className="rounded-lg px-3 py-1.5 text-strong text-kin-secondary disabled:opacity-50"
          onClick={onCancel}
        >
          {tr("routines.cancel")}
        </button>
        {/* eslint-disable-next-line kin/no-raw-button -- same control, moved. */}
        <button
          type="button"
          // A one-off with no date-time is refused on submit with a
          // message, not by a disabled button: the schedule field beside
          // it still says "runs on the next tick", so a dead Save would
          // be the only thing telling the reader otherwise.
          disabled={formLocked || !prompt.trim() || !cwd.trim()}
          className="rounded-lg bg-kin-blue px-3 py-1.5 text-strong font-medium text-kin-on-brand disabled:opacity-50"
          onClick={onSubmit}
        >
          {editing ? tr("routines.save") : tr("routines.createAndOpen")}
        </button>
      </div>
    </section>
  );
}
