import {
  useId,
  useRef,
  useState,
  type ReactNode,
  type RefObject,
} from "react";
import type { AgentInfo } from "../../api/client";
import { useMinWidth } from "../../hooks/useMinWidth";
import { useT } from "../../i18n/react";
import { agentAvatarMeta } from "../../lib/agentMention";
import {
  CUSTOM_MODEL_ID,
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
import { IconX } from "../icons";
import Sheet, { useSheetLayer } from "../mobile/Sheet";
import Button from "../ui/Button";
import Menu from "../ui/Menu";
import Popover from "../ui/Popover";

/**
 * The phone's run settings, behind one ghost face in the composer.
 *
 * This replaces the strip of chips under the composer, which put the same two
 * facts (model, permission) on a second line and could not grow a third
 * setting without another chip. The pattern is the one the reference phone
 * client uses: the composer footer names the current configuration on one
 * line, and a sheet owns the controls. Inside the sheet every row is a card
 * with a fixed label column, and a row opens its options in a second layer
 * over the sheet rather than pushing a second sheet — the value you are
 * changing and the list you are changing it from stay in one place on screen.
 *
 * Deliberately absent: reasoning effort, which the daemon protocol this
 * console speaks does not carry — a row that cannot be honoured is worse than
 * a row that is not drawn. Role presets are absent from *this* sheet for a
 * different reason: a role is a prompt prefix, not a run setting, and it is
 * chosen on the new-chat page where the draft it edits is (see
 * `lib/agentRoles`).
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
function faceModelLabel(model: string, models: AgentModelOption[], fallback: string): string {
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
  const triggerRef = useRef<HTMLButtonElement>(null);
  // One face at every width; what it opens changes width. A phone gets the
  // bottom sheet, a Mac the anchored panel — the same split `SheetSelect`
  // already makes for every other one-choice control.
  const wide = useMinWidth(768);
  const current = model.trim();
  const mode = normalizePermissionMode(permission);
  const permissionLabel = tr(PERMISSION_MODE_LABEL_KEY[mode]);
  const modelLabel = faceModelLabel(
    current,
    models,
    fallbackModelLabel ?? tr("modelPicker.default"),
  );

  const body: SheetProps = {
    open,
    onClose: () => setOpen(false),
    agentName,
    agentId,
    agentAvatar,
    model: current,
    models,
    onModelChange,
    permission: mode,
    permissionModes,
    onPermissionChange,
    disabled,
    fallbackModelLabel,
    agents,
    onAgentChange,
    extraRows,
  };

  return (
    <>
      <Button
        ref={triggerRef}
        variant="quiet"
        onClick={() => setOpen((value) => !value)}
        disabled={disabled}
        aria-label={`${tr("runConfig.open")}${tr("common.labelSeparator")}${agentName} · ${modelLabel} · ${permissionLabel}`}
        aria-haspopup="dialog"
        aria-expanded={open}
        // The shared button is a one-line box by construction. This face is
        // two lines and lets a long agent or model name wrap, so the height is
        // content-driven again. Astryx wraps the children in its own label
        // span, which sizes to content; the last selector makes that span fill
        // the face so the two lines get the full width before they wrap.
        className={[
          "flex h-auto min-h-11 min-w-0 max-w-full items-center justify-start gap-1.5 rounded-lg px-1.5 py-1 text-left font-normal whitespace-normal [&>span>span]:w-full",
          className,
        ].join(" ")}
      >
        <span className="flex w-full min-w-0 items-center gap-1.5">
          <span
            className={`flex h-5 w-5 flex-none items-center justify-center rounded-md text-micro font-semibold ${agentAvatar.className}`}
          >
            {agentAvatar.initials}
          </span>
          {/* Two lines, not one: the face has to name the agent, the model and
              the mode, and on a 320px phone one line left the first two as
              ellipses. The agent owns the first line and the model hangs under
              it — the model belongs to that agent — with the mode beside the
              model. Neither value truncates; a long name wraps, because a phone
              has no hover to reveal a `title` and the choice has to be readable
              before it is changed. */}
          <span className="flex min-w-0 flex-1 flex-col gap-0.5">
            <span className="min-w-0 break-words text-caption font-semibold text-kin-secondary">
              {agentName}
            </span>
            <span className="flex min-w-0 flex-wrap items-baseline gap-x-1.5 gap-y-0">
              <span className="min-w-0 break-words text-strong text-kin-text">{modelLabel}</span>
              <span aria-hidden className="flex-none select-none text-kin-muted/60">
                ·
              </span>
              <span
                className={[
                  "whitespace-nowrap text-caption font-medium",
                  mode === "yolo" ? "text-kin-orange-ink" : "text-kin-muted",
                ].join(" ")}
              >
                {permissionLabel}
              </span>
            </span>
          </span>
        </span>
      </Button>
      {wide ? <RunConfigPanel triggerRef={triggerRef} {...body} /> : <RunConfigSheet {...body} />}
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

/**
 * The layers `extraRows` open that are not `Popover`s: `DispatchSelector` and
 * its neighbours portal a `role="dialog"` to `<body>` themselves, so the
 * shared layer registry cannot see them. A press inside one must not read as
 * "outside" and close this panel — that unmounts the picker before its click
 * lands — so the panel opts their markers into its pointer reach. Escape is
 * not widened: it still belongs to the layer holding focus.
 */
const EXTRA_ROW_POINTER_REACH =
  '[data-search-panel], [data-kin-sheet], [role="menu"], [role="dialog"]';

/**
 * The desktop shape of the run settings: the sheet's rows in an anchored panel.
 *
 * A Mac is not a phone, and `Sheet` is deliberately phone-only — a bottom
 * sheet over a desktop window is the platform mismatch `TASTE.md` rule 3
 * names. The body is the same one the sheet draws, in the same row order, so
 * a reader moving between a Mac and a phone finds the settings where they
 * left them; only the container changes.
 *
 * The container is the shared `Popover`: it owns viewport anchoring, the
 * outside pointer, Escape, Tab containment and returning focus to the face.
 * A row's own picker opens a second `Popover` from inside this panel's React
 * tree, so the primitive counts it as this layer's reach: a click on an option
 * keeps the panel open, one Escape dismisses the option layer and the next the
 * panel — including when focus is on this header.
 */
function RunConfigPanel({
  open,
  onClose,
  triggerRef,
  ...body
}: SheetProps & { triggerRef: RefObject<HTMLButtonElement | null> }) {
  const tr = useT();
  return (
    <Popover
      open={open}
      onOpenChange={(next) => {
        if (!next) onClose();
      }}
      triggerRef={triggerRef}
      label={tr("runConfig.title")}
      placement="above"
      align="left"
      width={400}
      maxWidth={520}
      maxHeight={560}
      pointerReach={EXTRA_ROW_POINTER_REACH}
    >
      {/* The panel is the scrollport (`overflow-y-auto`, `p-1.5`), so the
          header sticks to its top edge while the rows scroll under it. The
          negative margins take back the panel's own padding, so the header
          and body keep the geometry they had before the shared layer owned
          the box. */}
      <div className="sticky top-0 z-10 -mx-1.5 -mt-1.5 flex items-center justify-between border-b border-[var(--kin-hairline)] bg-kin-elevated px-3 py-1.5">
        <h2 className="text-caption font-semibold text-kin-secondary">{tr("runConfig.title")}</h2>
        <Button
          variant="quiet"
          onClick={() => {
            onClose();
            triggerRef.current?.focus({ preventScroll: true });
          }}
          aria-label={tr("common.close")}
          className="h-7 w-7 flex-none p-0"
        >
          {/* The muted ink sits on the glyph: the quiet weight's own text
              colour is a utility emitted after this call site's, so it would
              win over a `text-kin-muted` on the button. */}
          <IconX size={14} className="text-kin-muted" />
        </Button>
      </div>
      <div className="-mx-1.5 -mb-1.5 px-3 pb-3 pt-2">
        <RunConfigBody {...body} />
      </div>
    </Popover>
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
  // The option layer is part of this sheet's modal even though it is portaled
  // out of the panel: Tab stays inside both, Back closes it first, and the
  // sheet stops claiming `aria-modal` over a subtree it does not contain.
  useSheetLayer(Boolean(openRow), () => setOpenRow(null));
  const [query, setQuery] = useState("");
  const [customPicked, setCustomPicked] = useState(false);
  // The control that opened each row, not the card: the shared popover hangs
  // the layer from the trigger and returns focus there when it closes.
  const rowRefs = useRef<Record<RowId, RefObject<HTMLButtonElement | null>>>({
    agent: { current: null },
    model: { current: null },
    permission: { current: null },
  });
  // Names the free-text field's label; the field is a footer of the model
  // layer, so nothing outside it points at an id.
  const customFieldId = useId();

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
  // A query is a hunt through the catalog, and Enter takes the first row it
  // kept. The Custom sentinel is not a model: if it survived the filter,
  // typing "cus" would put it first and Enter would open the free-text editor
  // instead of choosing something. With an empty query it stays last.
  const modelRows = normalizedQuery
    ? filtered.filter((option) => option.id !== CUSTOM_MODEL_ID)
    : filtered;
  const agentPicker = agents && onAgentChange ? agents.filter((a) => a.available) : [];
  const modelFallback = fallbackModelLabel ?? tr("modelPicker.default");

  // One row at a time; switching rows clears the previous query.
  function toggleRow(row: RowId) {
    setOpenRow((current) => (current === row ? null : row));
    setQuery("");
  }

  function pickAgent(agentId: string) {
    onAgentChange?.(agentId);
    setOpenRow(null);
    rowRefs.current.agent.current?.focus();
  }

  function pickModel(id: string) {
    const target = modelPickTarget(id);
    setCustomPicked(target.custom);
    onModelChange(target.value);
    // The layer closes for a real model and stays up for Custom, whose footer
    // is the editor the reader is about to type in; `Menu` owns both moves.
  }

  function pickPermission(mode: PermissionMode) {
    onPermissionChange(mode);
    setOpenRow(null);
    rowRefs.current.permission.current?.focus();
  }

  return (
    <div className="flex flex-col gap-1">
      {agentPicker.length > 0 ? (
        <RunConfigSheetRow
          label={tr("runConfig.agent")}
          control={
            <PickerTrigger
              triggerRef={rowRefs.current.agent}
              label={tr("runConfig.agent")}
              value={agentName}
              expanded={openRow === "agent"}
              disabled={disabled}
              onClick={() => toggleRow("agent")}
            >
              <span
                className={`flex h-5 w-5 flex-none items-center justify-center rounded-md text-micro font-semibold ${agentAvatar.className}`}
              >
                {agentAvatar.initials}
              </span>
              <span className="min-w-0 flex-1 break-words">{agentName}</span>
            </PickerTrigger>
          }
        >
          <Menu
            open={openRow === "agent"}
            onOpenChange={(next) => {
              if (!next) setOpenRow(null);
            }}
            triggerRef={rowRefs.current.agent}
            label={tr("runConfig.agent")}
            items={agentPicker.map((agent) => {
              const meta = agentAvatarMeta(agent.id);
              return {
                id: agent.id,
                label: agent.name,
                icon: (
                  <span
                    className={`flex h-5 w-5 items-center justify-center rounded-md text-micro font-semibold ${meta.className}`}
                  >
                    {meta.initials}
                  </span>
                ),
                checked: agent.id === agentId,
                onSelect: () => pickAgent(agent.id),
              };
            })}
            // A session that already has a host opens on it, so the next
            // arrow key moves from the current agent instead of the top.
            initialFocusId={agentId}
            placement="above"
            width={240}
          />
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
              <span className="min-w-0 break-words">{agentName}</span>
            </div>
          }
        />
      )}

      <RunConfigSheetRow
        label={tr("modelPicker.label")}
        control={
          <PickerTrigger
            triggerRef={rowRefs.current.model}
            label={tr("modelPicker.label")}
            value={faceModelLabel(model, models, modelFallback)}
            expanded={openRow === "model"}
            disabled={disabled}
            onClick={() => toggleRow("model")}
          >
            {faceModelLabel(model, models, modelFallback)}
          </PickerTrigger>
        }
      >
        {/* The menu portals its panel out of the sheet, so the sheet's own
            Escape check cannot find it inside the panel. This marker is how an
            open row tells the sheet a layer above it is open; `useSheetLayer`
            already gives Back the same answer. */}
        {openRow === "model" ? <div data-sheet-layer /> : null}
        <Menu
          open={openRow === "model"}
          onOpenChange={(next) => {
            if (!next) setOpenRow(null);
          }}
          triggerRef={rowRefs.current.model}
          label={tr("modelPicker.label")}
          items={modelRows.map((option) => ({
            id: option.id,
            label: option.label,
            description: option.detail,
            checked: option.id === selection,
            // Custom configures the footer instead of choosing a value, so the
            // field it reveals is not unmounted by its own choice.
            keepOpen: option.id === CUSTOM_MODEL_ID,
            onSelect: () => pickModel(option.id),
          }))}
          // A short catalog opens on the choice that is set; a long one opens
          // in the field, where the reader has to narrow it first.
          initialFocusId={selection}
          placement="above"
          width={320}
          emptyLabel={tr("modelPicker.searchEmpty")}
          search={
            searchable
              ? {
                  value: query,
                  onChange: setQuery,
                  label: tr("modelPicker.searchPlaceholder"),
                  placeholder: tr("modelPicker.searchPlaceholder"),
                  clearLabel: tr("common.clear"),
                }
              : undefined
          }
          footer={
            custom ? (
              <div className="border-t border-[var(--kin-hairline)] px-3 py-2">
                <label
                  className="text-caption font-medium text-kin-muted"
                  htmlFor={customFieldId}
                >
                  {tr("modelPicker.customLabel")}
                </label>
                <input
                  id={customFieldId}
                  autoFocus={customPicked}
                  value={model}
                  onChange={(event) => onModelChange(event.target.value)}
                  placeholder={tr("modelPicker.customPlaceholder")}
                  className="mt-1 min-h-10 w-full rounded-lg border border-[var(--kin-hairline-strong)] bg-kin-elevated px-2.5 text-strong text-kin-text outline-none placeholder:text-kin-muted focus:ring-1 focus:ring-kin-focus-ring"
                />
              </div>
            ) : undefined
          }
        />
      </RunConfigSheetRow>

      {permissionModes.length > 0 ? (
        <RunConfigSheetRow
          label={tr("permission.label")}
          control={
            <PickerTrigger
              triggerRef={rowRefs.current.permission}
              label={tr("permission.label")}
              value={tr(PERMISSION_MODE_LABEL_KEY[mode])}
              expanded={openRow === "permission"}
              disabled={disabled}
              onClick={() => toggleRow("permission")}
              tone={mode === "yolo" ? "warning" : undefined}
            >
              {tr(PERMISSION_MODE_LABEL_KEY[mode])}
            </PickerTrigger>
          }
        >
          <Menu
            open={openRow === "permission"}
            onOpenChange={(next) => {
              if (!next) setOpenRow(null);
            }}
            triggerRef={rowRefs.current.permission}
            label={tr("permission.label")}
            // The consequence stays inside the row, so it is read as part of
            // the mode's name rather than hidden in a tooltip — the same
            // contract as the composer's permission chip.
            items={permissionModes.map((option) => ({
              id: option,
              label: tr(PERMISSION_MODE_LABEL_KEY[option]),
              description: tr(PERMISSION_HINT_KEY[option]),
              checked: option === mode,
              onSelect: () => pickPermission(option),
            }))}
            initialFocusId={mode}
            placement="above"
            width={288}
          />
        </RunConfigSheetRow>
      ) : null}

      {/* New chat only: where the run happens. An existing session no longer
          owns machine / workspace / branch / dispatch / routine, so the caller
          renders those rows here instead of beside the composer. */}
      {extraRows}
    </div>
  );
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
    // A row's options are a layer over this card, not a block that grows it.
    // The layer hangs from the trigger inside `control`, and the sheet keeps
    // its height and the rows below keep their places while a picker is open.
    <div data-run-config-row>
      <div className="flex items-center gap-3 rounded-xl border border-[var(--kin-hairline)] bg-kin-elevated px-3 py-2">
        <span className="w-20 flex-none text-caption font-semibold text-kin-secondary">
          {label}
        </span>
        <div className="min-w-0 flex-1">{control}</div>
      </div>
      {children}
    </div>
  );
}

/**
 * The filled control that names a row's current value.
 *
 * No chevron: the reference's trigger is a value on a filled surface, and the
 * open state is a ring plus the darker fill — the layer opening over the card
 * is the other half of the signal, so a glyph pointing at it would be saying
 * the same thing twice.
 */
function PickerTrigger({
  triggerRef,
  label,
  value,
  expanded,
  disabled,
  onClick,
  tone,
  children,
}: {
  triggerRef: RefObject<HTMLButtonElement | null>;
  label: string;
  /** Named for assistive tech as well: the trigger hides its text behind an
   *  `aria-label`, and a row that announces only "Model" does not say what the
   *  model currently is. */
  value: string;
  expanded: boolean;
  disabled?: boolean;
  onClick: () => void;
  tone?: "warning";
  children: ReactNode;
}) {
  const tr = useT();
  return (
    <Button
      ref={triggerRef}
      // The row is a filled surface, and the quiet weight's `bg-transparent`
      // utility is emitted after arbitrary background utilities, so it would
      // erase the fill. The secondary weight keeps its shape in the component
      // layer, which this call site's utilities do override: the border is
      // turned off and the row draws its own fill. (A `plain` weight with no
      // background at all is the cleaner long-term home; see C1c2b.)
      variant="secondary"
      onClick={onClick}
      disabled={disabled}
      data-run-config-trigger
      aria-label={`${label}${tr("common.labelSeparator")}${value}`}
      aria-haspopup="menu"
      aria-expanded={expanded}
      // A menu names no panel id of its own, so no row points
      // `aria-controls` at a layer.
      // The shared button is a one-line box; this row's value wraps, so its
      // height stays content-driven. Astryx wraps the children in a label span
      // that sizes to content, and the last selector makes that span fill the
      // row so a long value wraps at the row's edge rather than its own.
      // `min-h-11` is the touch floor (44px), not decoration: on a phone this
      // row is the tap target that opens the options, and the previous
      // `min-h-10` left it 4px under the floor the shared button ships with.
      className={[
        "flex h-auto min-h-11 w-full items-center justify-start rounded-lg border-0 px-3 py-1.5 text-left text-strong font-medium whitespace-normal [&>span>span]:w-full",
        expanded
          ? "bg-[var(--kin-fill-strong)] text-kin-text ring-2 ring-kin-blue/30"
          : "bg-[var(--kin-fill)] text-kin-text hover:bg-[var(--kin-fill-strong)]",
        disabled ? "opacity-60" : "",
      ].join(" ")}
    >
      {/* Wraps rather than ellipsizes: this row is the one place the sheet
          states the current value, and a name that only fits behind a `title`
          is a name a phone cannot read. The ink stays on the inner span so the
          shared weight's own text utility cannot win the cascade. */}
      <span
        className={[
          "flex w-full min-w-0 items-center gap-2 whitespace-normal break-words",
          tone === "warning" && !expanded ? "text-kin-orange-ink" : "",
        ].join(" ")}
      >
        {children}
      </span>
    </Button>
  );
}
