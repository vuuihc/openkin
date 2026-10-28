import { useId, useRef, useState, type KeyboardEvent as ReactKeyboardEvent, type ReactNode } from "react";
import type { AgentInfo } from "../../api/client";
import { useT } from "../../i18n/react";
import { agentAvatarMeta } from "../../lib/agentMention";
import {
  isListedModel,
  modelPickTarget,
  modelPickerLabel,
  modelPickerOptions,
  modelPickerSelection,
  type AgentModelOption,
} from "../../lib/agentModels";
import {
  normalizePermissionMode,
  PERMISSION_MODE_LABEL_KEY,
  type PermissionMode,
} from "../../lib/permissionMode";
import { IconCheck, IconSearch, IconX } from "../icons";
import Sheet from "../mobile/Sheet";

/**
 * The phone's run settings, behind one ghost face in the composer.
 *
 * This replaces the strip of chips under the composer, which put the same two
 * facts (model, permission) on a second line and could not grow a third
 * setting without another chip. The pattern is the one the reference phone
 * client uses: the composer footer names the current configuration on one
 * line, and a sheet owns the controls. Inside the sheet every row is a card
 * with a fixed label column, and a row expands its options *under itself*
 * rather than pushing a second sheet — the value you are changing and the
 * list you are changing it from stay in one place on screen.
 *
 * Deliberately absent: role presets and reasoning effort. The daemon protocol
 * this console speaks has neither, and a row that cannot be honoured is worse
 * than a row that is not drawn.
 */
export type RunConfigAvatar = { initials: string; className: string };

export type RunConfigControlProps = {
  /** The host agent's display name, shown on the face and the Agent row. */
  agentName: string;
  /** The host agent's id, for marking the current Agent row in the sheet. */
  agentId?: string;
  agentAvatar: RunConfigAvatar;
  /** Selected model id; "" is the agent / provider default. */
  model: string;
  models: AgentModelOption[];
  onModelChange: (modelId: string) => void;
  permission: PermissionMode | string;
  /** The modes the machine running this session actually offers. */
  permissionModes: PermissionMode[];
  onPermissionChange: (mode: PermissionMode) => void;
  disabled?: boolean;
  className?: string;
  /**
   * What the model row names when no model is set: the model the transcript
   * reports (the session page), so the face says what the run is actually
   * using instead of the generic default. Omit on new-chat, where there is
   * no run yet to name.
   */
  fallbackModelLabel?: string;
  /**
   * Offered together: when both are set the Agent row is a picker (a session
   * that has not started can still change its host); with neither it is a
   * locked value (an existing session's agent is part of its identity).
   */
  agents?: AgentInfo[];
  onAgentChange?: (agentId: string) => void;
  /**
   * New-chat only: the location controls (machine, workspace, branch,
   * dispatch, routine) that an existing session no longer owns. Rendered
   * after the permission row so the sheet stays one place to see how the
   * next run will go.
   */
  extraRows?: ReactNode;
};

/** The face's model text: the catalog label, or the id's tail for a custom one. */
function faceModelLabel(
  model: string,
  models: AgentModelOption[],
  fallback: string,
): string {
  const current = model.trim();
  if (!current) return fallback;
  const listed = models.find((m) => m.id === current);
  return listed ? modelPickerLabel(listed) : modelPickerLabel({ id: current });
}

export default function RunConfigControl({
  agentName,
  agentId,
  agentAvatar,
  model,
  models,
  onModelChange,
  permission,
  permissionModes,
  onPermissionChange,
  disabled,
  className = "",
  fallbackModelLabel,
  agents,
  onAgentChange,
  extraRows,
}: RunConfigControlProps) {
  const tr = useT();
  const [open, setOpen] = useState(false);
  const current = model.trim();
  const mode = normalizePermissionMode(permission);
  const permissionLabel = tr(PERMISSION_MODE_LABEL_KEY[mode]);
  const modelLabel = faceModelLabel(current, models, fallbackModelLabel ?? tr("modelPicker.default"));

  return (
    <>
      <button
        type="button"
        onClick={() => setOpen(true)}
        disabled={disabled}
        aria-label={`${tr("runConfig.open")}${tr("common.labelSeparator")}${agentName} · ${modelLabel} · ${permissionLabel}`}
        aria-haspopup="dialog"
        aria-expanded={open}
        className={[
          "flex min-h-11 min-w-0 max-w-full items-center gap-1.5 overflow-hidden rounded-lg px-1.5 text-left transition-colors active:bg-[var(--kin-fill)] disabled:opacity-50",
          className,
        ].join(" ")}
      >
        <span
          className={`flex h-5 w-5 flex-none items-center justify-center rounded-md text-micro font-semibold ${agentAvatar.className}`}
        >
          {agentAvatar.initials}
        </span>
        {/* Truncates keeping the tail: `provider/model-name` should lose the
            provider, not the model — the same `direction: rtl` trick the
            reference uses. */}
        <span className="min-w-0 truncate text-strong [direction:rtl]" title={modelLabel}>
          <span dir="ltr">{modelLabel}</span>
        </span>
        <span aria-hidden className="flex-none select-none text-kin-muted/60">
          ·
        </span>
        <span
          className={[
            "flex-none whitespace-nowrap text-caption font-medium",
            mode === "yolo" ? "text-kin-orange-ink" : "text-kin-muted",
          ].join(" ")}
        >
          {permissionLabel}
        </span>
      </button>
      <RunConfigSheet
        open={open}
        onClose={() => setOpen(false)}
        agentName={agentName}
        agentId={agentId}
        agentAvatar={agentAvatar}
        model={current}
        models={models}
        onModelChange={onModelChange}
        permission={mode}
        permissionModes={permissionModes}
        onPermissionChange={onPermissionChange}
        disabled={disabled}
        fallbackModelLabel={fallbackModelLabel}
        agents={agents}
        onAgentChange={onAgentChange}
        extraRows={extraRows}
      />
    </>
  );
}

type SheetProps = Omit<RunConfigControlProps, "className"> & {
  open: boolean;
  onClose: () => void;
};

/**
 * The sheet body is only mounted while open, so every expansion, query and
 * "just picked Custom" flag resets by construction instead of by an effect
 * that has to remember all three.
 */
function RunConfigSheet({ open, onClose, ...body }: SheetProps) {
  const tr = useT();
  return (
    <Sheet open={open} onClose={onClose} title={tr("runConfig.title")} bodyClassName="pb-2">
      {open ? <RunConfigBody {...body} /> : null}
    </Sheet>
  );
}

type RowId = "agent" | "model" | "permission";

const PERMISSION_HINT_KEY: Record<PermissionMode, string> = {
  default: "permission.defaultHint",
  accept_edits: "permission.acceptEditsHint",
  yolo: "permission.yoloHint",
};

function RunConfigBody({
  agentName,
  agentId,
  agentAvatar,
  model,
  models,
  onModelChange,
  permission,
  permissionModes,
  onPermissionChange,
  disabled,
  fallbackModelLabel,
  agents,
  onAgentChange,
  extraRows,
}: Omit<SheetProps, "open" | "onClose">) {
  const tr = useT();
  const [openRow, setOpenRow] = useState<RowId | null>(null);
  const [query, setQuery] = useState("");
  const [customPicked, setCustomPicked] = useState(false);
  const [modelList, setModelList] = useState<HTMLDivElement | null>(null);
  const rowRefs = useRef<Record<RowId, HTMLButtonElement | null>>({
    agent: null,
    model: null,
    permission: null,
  });
  const listId = useId();

  const mode = normalizePermissionMode(permission);
  const modelOptions = modelPickerOptions(models, {
    default: tr("modelPicker.default"),
    custom: tr("modelPicker.custom"),
  });
  const currentIsCustom = Boolean(model) && !isListedModel(models, model);
  const custom = customPicked || currentIsCustom;
  const selection = modelPickerSelection(model, custom);
  const searchable = models.length > 6;
  const normalizedQuery = query.trim().toLowerCase();
  const filtered =
    searchable && normalizedQuery
      ? modelOptions.filter((option) =>
          // Everything the row shows, so a gateway name or a raw id finds a
          // model whose label does not contain the word — the same match
          // `SearchSelect` applies to its own filter.
          [option.label, option.id, option.detail ?? ""].some((text) =>
            text.toLowerCase().includes(normalizedQuery),
          ),
        )
      : modelOptions;
  const agentPicker = agents && onAgentChange ? agents.filter((a) => a.available) : [];
  const modelFallback = fallbackModelLabel ?? tr("modelPicker.default");

  /** First/last option in the model list, for the search field's arrow keys. */
  function focusOption(which: "first" | "last") {
    const items = modelList?.querySelectorAll<HTMLButtonElement>('[role="option"]');
    if (!items?.length) return;
    const target = which === "first" ? items[0] : items[items.length - 1];
    target?.focus();
  }

  // One row at a time; switching rows clears the previous query.
  function toggleRow(row: RowId) {
    setOpenRow((current) => (current === row ? null : row));
    setQuery("");
  }

  function closeRow(row: RowId) {
    setOpenRow(null);
    rowRefs.current[row]?.focus();
  }

  function pickAgent(agentId: string) {
    onAgentChange?.(agentId);
    setOpenRow(null);
    rowRefs.current.agent?.focus();
  }

  function pickModel(id: string) {
    const target = modelPickTarget(id);
    setCustomPicked(target.custom);
    onModelChange(target.value);
    if (!target.custom) {
      setOpenRow(null);
      rowRefs.current.model?.focus();
    }
  }

  function pickPermission(mode: PermissionMode) {
    onPermissionChange(mode);
    setOpenRow(null);
    rowRefs.current.permission?.focus();
  }

  return (
    <div
      className="flex flex-col gap-1"
      onKeyDown={(event) => {
        // The sheet's own Escape trap declines to close while a listbox is
        // open inside it (see Sheet.tsx), which leaves this layer to close the
        // expansion first. The second Escape then closes the sheet.
        if (event.key === "Escape" && openRow) {
          event.stopPropagation();
          closeRow(openRow);
        }
      }}
    >
      {agentPicker.length > 0 ? (
        <RunConfigSheetRow
          label={tr("runConfig.agent")}
          control={
            <PickerTrigger
              triggerRef={(node) => {
                rowRefs.current.agent = node;
              }}
              label={tr("runConfig.agent")}
              value={agentName}
              expanded={openRow === "agent"}
              controls={`${listId}-agent`}
              disabled={disabled}
              onClick={() => toggleRow("agent")}
            >
              <span
                className={`flex h-5 w-5 flex-none items-center justify-center rounded-md text-micro font-semibold ${agentAvatar.className}`}
              >
                {agentAvatar.initials}
              </span>
              <span className="min-w-0 truncate">{agentName}</span>
            </PickerTrigger>
          }
        >
          {openRow === "agent" ? (
            <Expansion id={`${listId}-agent`}>
              <div
                role="listbox"
                aria-label={tr("runConfig.agent")}
                onKeyDown={moveListFocus}
                className="py-1"
              >
                {agentPicker.map((agent) => {
                  const selected = agent.id === agentId;
                  const meta = agentAvatarMeta(agent.id);
                  return (
                    <button
                      key={agent.id}
                      type="button"
                      role="option"
                      aria-selected={selected}
                      onClick={() => pickAgent(agent.id)}
                      className={[
                        "flex min-h-11 w-full items-center gap-2 px-3 py-1.5 text-left text-strong transition-colors",
                        selected ? "font-medium text-kin-text" : "text-kin-secondary",
                        "hover:bg-[var(--kin-fill)] focus:bg-[var(--kin-fill)] focus:outline-none",
                      ].join(" ")}
                    >
                      <span
                        className={`flex h-5 w-5 flex-none items-center justify-center rounded-md text-micro font-semibold ${meta.className}`}
                      >
                        {meta.initials}
                      </span>
                      <span className="min-w-0 flex-1 truncate">{agent.name}</span>
                      {selected ? (
                        <IconCheck size={16} className="flex-none text-kin-blue-ink" />
                      ) : null}
                    </button>
                  );
                })}
              </div>
            </Expansion>
          ) : null}
        </RunConfigSheetRow>
      ) : (
        <RunConfigSheetRow
          label={tr("runConfig.agent")}
          // Read-only once a session exists: the agent is part of its identity,
          // and the daemon has no protocol to swap it mid-session. Not a
          // disabled button — that reads as broken and is skipped by screen
          // readers; a plain value with no chevron reads as a fact.
          control={
            <div
              className="flex min-h-10 items-center gap-2 rounded-lg bg-[var(--kin-fill)] px-3 text-strong font-medium text-kin-secondary"
              title={tr("runConfig.agentLocked")}
            >
              <span
                className={`flex h-5 w-5 flex-none items-center justify-center rounded-md text-micro font-semibold ${agentAvatar.className}`}
              >
                {agentAvatar.initials}
              </span>
              <span className="truncate">{agentName}</span>
            </div>
          }
        />
      )}

      <RunConfigSheetRow
        label={tr("modelPicker.label")}
        control={
          <PickerTrigger
            triggerRef={(node) => {
              rowRefs.current.model = node;
            }}
            label={tr("modelPicker.label")}
            value={faceModelLabel(model, models, modelFallback)}
            expanded={openRow === "model"}
            controls={listId}
            disabled={disabled}
            onClick={() => toggleRow("model")}
          >
            {faceModelLabel(model, models, modelFallback)}
          </PickerTrigger>
        }
      >
        {openRow === "model" ? (
          <Expansion id={listId}>
            {searchable ? (
              <SearchField
                value={query}
                onChange={setQuery}
                placeholder={tr("modelPicker.searchPlaceholder")}
                label={tr("modelPicker.searchPlaceholder")}
                clearLabel={tr("common.clear")}
                onArrowDown={() => focusOption("first")}
                onArrowUp={() => focusOption("last")}
                // Filtering down to the row you want and pressing Enter should
                // take it, rather than requiring an ArrowDown first.
                onSubmitFirst={() => {
                  const first = filtered[0];
                  if (first) pickModel(first.id);
                }}
              />
            ) : null}
            <div
              ref={setModelList}
              role="listbox"
              aria-label={tr("modelPicker.label")}
              onKeyDown={moveListFocus}
              className="max-h-[200px] overflow-y-auto kin-scroll py-1"
            >
              {filtered.length === 0 ? (
                <p className="px-3 py-2 text-body text-kin-muted">{tr("modelPicker.searchEmpty")}</p>
              ) : (
                filtered.map((option) => {
                  const selected = option.id === selection;
                  return (
                    <button
                      key={option.id || "default"}
                      type="button"
                      role="option"
                      aria-selected={selected}
                      onClick={() => pickModel(option.id)}
                      className={[
                        "flex min-h-11 w-full items-center gap-2 px-3 py-1.5 text-left text-strong transition-colors",
                        selected ? "font-medium text-kin-text" : "text-kin-secondary",
                        "hover:bg-[var(--kin-fill)] focus:bg-[var(--kin-fill)] focus:outline-none",
                      ].join(" ")}
                    >
                      <span className="flex min-w-0 flex-1 flex-col">
                        <span className="truncate">{option.label}</span>
                        {option.detail ? (
                          <span className="truncate text-caption text-kin-muted">{option.detail}</span>
                        ) : null}
                      </span>
                      {selected ? (
                        <IconCheck size={16} className="flex-none text-kin-blue-ink" />
                      ) : null}
                    </button>
                  );
                })
              )}
            </div>
            {custom ? (
              <div className="border-t border-[var(--kin-hairline)] px-3 py-2">
                <label
                  className="text-caption font-medium text-kin-muted"
                  htmlFor={`${listId}-custom`}
                >
                  {tr("modelPicker.customLabel")}
                </label>
                <input
                  id={`${listId}-custom`}
                  autoFocus={customPicked}
                  value={model}
                  onChange={(event) => onModelChange(event.target.value)}
                  placeholder={tr("modelPicker.customPlaceholder")}
                  className="mt-1 min-h-10 w-full rounded-lg border border-[var(--kin-hairline-strong)] bg-kin-elevated px-2.5 text-strong text-kin-text outline-none placeholder:text-kin-muted focus:ring-1 focus:ring-kin-focus-ring"
                />
              </div>
            ) : null}
          </Expansion>
        ) : null}
      </RunConfigSheetRow>

      {permissionModes.length > 0 ? (
        <RunConfigSheetRow
          label={tr("permission.label")}
          control={
            <PickerTrigger
              triggerRef={(node) => {
                rowRefs.current.permission = node;
              }}
              label={tr("permission.label")}
              value={tr(PERMISSION_MODE_LABEL_KEY[mode])}
              expanded={openRow === "permission"}
              controls={`${listId}-permission`}
              disabled={disabled}
              onClick={() => toggleRow("permission")}
              tone={mode === "yolo" ? "warning" : undefined}
            >
              {tr(PERMISSION_MODE_LABEL_KEY[mode])}
            </PickerTrigger>
          }
        >
          {openRow === "permission" ? (
            <Expansion id={`${listId}-permission`}>
              <div
                role="listbox"
                aria-label={tr("permission.label")}
                onKeyDown={moveListFocus}
                className="py-1"
              >
                {permissionModes.map((option) => {
                  const selected = option === mode;
                  return (
                    <button
                      key={option}
                      type="button"
                      role="option"
                      aria-selected={selected}
                      onClick={() => pickPermission(option)}
                      className={[
                        "flex min-h-11 w-full items-start gap-2 px-3 py-2 text-left text-strong transition-colors",
                        selected ? "font-medium text-kin-text" : "text-kin-secondary",
                        "hover:bg-[var(--kin-fill)] focus:bg-[var(--kin-fill)] focus:outline-none",
                      ].join(" ")}
                    >
                      <span className="flex min-w-0 flex-1 flex-col">
                        <span className="truncate">{tr(PERMISSION_MODE_LABEL_KEY[option])}</span>
                        <span className="text-caption text-kin-muted">
                          {tr(PERMISSION_HINT_KEY[option])}
                        </span>
                      </span>
                      {selected ? (
                        <IconCheck size={16} className="mt-0.5 flex-none text-kin-blue-ink" />
                      ) : null}
                    </button>
                  );
                })}
              </div>
            </Expansion>
          ) : null}
        </RunConfigSheetRow>
      ) : null}

      {/* New chat only: where the run happens. An existing session no longer
          owns machine / workspace / branch / dispatch / routine, so the caller
          renders those rows here instead of beside the composer. */}
      {extraRows}
    </div>
  );
}

/** Arrow keys walk the option buttons; Tab already reaches them. */
function moveListFocus(event: ReactKeyboardEvent<HTMLDivElement>) {
  // An IME candidate list owns the arrow keys until the composition ends;
  // moving focus mid-composition would abort the word being typed. Same guard
  // as `SearchSelect`, which is where this keyboard contract is written down.
  if (event.nativeEvent.isComposing) return;
  if (
    event.key !== "ArrowDown" &&
    event.key !== "ArrowUp" &&
    event.key !== "Home" &&
    event.key !== "End"
  ) {
    return;
  }
  const items = Array.from(
    event.currentTarget.querySelectorAll<HTMLButtonElement>('[role="option"]'),
  );
  if (items.length === 0) return;
  event.preventDefault();
  if (event.key === "Home") {
    items[0]?.focus();
    return;
  }
  if (event.key === "End") {
    items[items.length - 1]?.focus();
    return;
  }
  const index = items.indexOf(document.activeElement as HTMLButtonElement);
  // Up from the first option walks back out to the search field that ArrowDown
  // left, so the pair is reversible rather than one-way. The permission list
  // has no field above it, and there the old clamp still applies.
  if (event.key === "ArrowUp" && index <= 0) {
    const search = event.currentTarget.parentElement?.querySelector<HTMLInputElement>(
      "[data-picker-search]",
    );
    if (search) {
      search.focus();
      return;
    }
  }
  const next =
    event.key === "ArrowDown"
      ? Math.min(index + 1, items.length - 1)
      : Math.max(index <= 0 ? 0 : index - 1, 0);
  items[next]?.focus();
}

/** One labelled card, plus the row's expansion underneath it.
 *
 *  The expansion is a sibling of the card, not a child of the value column:
 *  it has to span the sheet's width to read as "this row opened" rather than
 *  as a dropdown hanging off the control, and it must not be clipped when the
 *  card is taller than its label.
 *
 *  Exported so the new-chat page can build its location rows (machine,
 *  workspace, branch, dispatch, routine) with the same card chrome.
 */
export function RunConfigSheetRow({
  label,
  control,
  children,
}: {
  label: string;
  control: ReactNode;
  children?: ReactNode;
}) {
  return (
    <div>
      <div className="flex items-center gap-3 rounded-xl border border-[var(--kin-hairline)] bg-kin-elevated px-3 py-2">
        <span className="w-20 flex-none text-caption font-semibold text-kin-secondary">{label}</span>
        <div className="min-w-0 flex-1">{control}</div>
      </div>
      {children ? <div className="mt-1.5">{children}</div> : null}
    </div>
  );
}

/**
 * The filled control that names a row's current value.
 *
 * No chevron: the reference's trigger is a value on a filled surface, and the
 * open state is a ring plus the darker fill — the expansion opening directly
 * under the card is the other half of the signal, so a glyph pointing at it
 * would be saying the same thing twice.
 */
function PickerTrigger({
  triggerRef,
  label,
  value,
  expanded,
  controls,
  disabled,
  onClick,
  tone,
  children,
}: {
  triggerRef: (node: HTMLButtonElement | null) => void;
  label: string;
  /** Named for assistive tech as well: the trigger hides its text behind an
   *  `aria-label`, and a row that announces only "Model" does not say what the
   *  model currently is. */
  value: string;
  expanded: boolean;
  controls: string;
  disabled?: boolean;
  onClick: () => void;
  tone?: "warning";
  children: ReactNode;
}) {
  const tr = useT();
  return (
    <button
      ref={triggerRef}
      type="button"
      onClick={onClick}
      disabled={disabled}
      aria-label={`${label}${tr("common.labelSeparator")}${value}`}
      aria-haspopup="listbox"
      aria-expanded={expanded}
      aria-controls={expanded ? controls : undefined}
      className={[
        "flex min-h-10 w-full items-center rounded-lg px-3 text-left text-strong font-medium transition-colors",
        expanded
          ? "bg-[var(--kin-fill-strong)] text-kin-text ring-2 ring-kin-blue/30"
          : "bg-[var(--kin-fill)] text-kin-text hover:bg-[var(--kin-fill-strong)]",
        tone === "warning" && !expanded ? "text-kin-orange-ink" : "",
        disabled ? "opacity-60" : "",
      ].join(" ")}
    >
      <span className="min-w-0 flex-1 truncate">{children}</span>
    </button>
  );
}

function Expansion({ id, children }: { id: string; children: ReactNode }) {
  return (
    <div
      id={id}
      className="overflow-hidden rounded-lg border border-[var(--kin-hairline)] bg-kin-elevated"
    >
      {children}
    </div>
  );
}

function SearchField({
  value,
  onChange,
  placeholder,
  label,
  clearLabel,
  onArrowDown,
  onArrowUp,
  onSubmitFirst,
}: {
  value: string;
  onChange: (value: string) => void;
  placeholder: string;
  label: string;
  clearLabel: string;
  onArrowDown: () => void;
  onArrowUp: () => void;
  onSubmitFirst: () => void;
}) {
  return (
    // The field draws no outline of its own, so the row is the focus
    // indicator. An inset `outline` rather than a ring: the expansion clips
    // its children, and the focus-ring token is the only colour the design
    // test lets a focus indicator use.
    <div className="flex min-h-11 items-center gap-2 border-b border-[var(--kin-hairline)] px-3 focus-within:bg-[var(--kin-fill)] focus-within:outline focus-within:outline-2 focus-within:-outline-offset-2 focus-within:outline-kin-focus-ring">
      <IconSearch size={14} className="flex-none text-kin-muted" />
      <input
        value={value}
        onChange={(event) => onChange(event.target.value)}
        onKeyDown={(event) => {
          // The IME guard is the load-bearing line for a Chinese model name:
          // the candidate list owns the arrows and Enter until it closes.
          if (event.nativeEvent.isComposing) return;
          if (event.key === "ArrowDown") {
            event.preventDefault();
            onArrowDown();
          } else if (event.key === "ArrowUp") {
            event.preventDefault();
            onArrowUp();
          } else if (event.key === "Enter") {
            event.preventDefault();
            onSubmitFirst();
          }
        }}
        // How ArrowUp gets back out of the option list (see `moveListFocus`).
        data-picker-search
        placeholder={placeholder}
        aria-label={label}
        className="min-h-11 min-w-0 flex-1 bg-transparent text-strong text-kin-text outline-none placeholder:text-kin-muted"
      />
      {value ? (
        <button
          type="button"
          onClick={() => onChange("")}
          aria-label={clearLabel}
          title={clearLabel}
          className="flex h-7 w-7 flex-none items-center justify-center rounded-full text-kin-muted hover:text-kin-text"
        >
          <IconX size={13} />
        </button>
      ) : null}
    </div>
  );
}
