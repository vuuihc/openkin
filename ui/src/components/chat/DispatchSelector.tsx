import { useCallback, useEffect, useId, useRef, useState, useSyncExternalStore } from "react";
import {
  getRoutingOptions,
  getRoutingPreview,
  type RoutingOptions,
  type RoutingPreview,
  type ModelSpec,
} from "../../api/client";
import { useT } from "../../i18n/react";
import { useCoarsePointer } from "../../hooks/useMediaQuery";
import Button from "../ui/Button";
import Popover from "../ui/Popover";
import SearchSelect, { type SearchSelectOption } from "../ui/SearchSelect";
import { sheetCount, subscribeSheets, useSheetLayer } from "../mobile/Sheet";

type DispatchMode = "auto" | "manual" | "";

export type DispatchSelection = {
  mode?: DispatchMode;
  team?: string;
  objective?: string;
  agent?: string;
  provider?: string;
  model?: string;
};

type Props = {
  value: DispatchSelection;
  onChange: (sel: DispatchSelection) => void;
  disabled?: boolean;
  onPreviewBlocked?: (blocked: boolean) => void;
  prompt?: string;
  routine?: boolean;
};

type Translate = (path: string) => string;

type DispatchSummaryOptions = {
  teams?: Array<{ id: string; name?: string }>;
  agents?: Array<{ id: string; name?: string }>;
  providers?: Array<{ id: string; name?: string }>;
};

function formatObjectiveLabel(objective: string, tr: Translate): string {
  switch (objective) {
    case "balanced":
      return tr("settings.routing.objectiveBalanced");
    case "cost-min":
      return tr("settings.routing.objectiveCostMin");
    case "intelligent-max":
      return tr("settings.routing.objectiveIntelligentMax");
    default:
      return objective;
  }
}

function formatPreviewStatus(status: string, tr: Translate): string {
  switch (status) {
    case "blocked":
      return tr("settings.routing.blocked");
    case "resolved":
      return tr("settings.routing.resolved");
    case "unresolved":
      return tr("settings.routing.unresolved");
    default:
      return status;
  }
}

export function getDispatchSummary(
  value: DispatchSelection,
  options: DispatchSummaryOptions | null,
  tr: Translate,
): string {
  const mode = value.mode || "auto";
  const teams = options?.teams ?? [];
  const agents = options?.agents ?? [];
  const providers = options?.providers ?? [];

  if (!value.mode) return tr("dispatch.label");
  if (mode === "auto") {
    const team = teams.find((t) => t.id === value.team);
    const obj = formatObjectiveLabel(value.objective || "balanced", tr);
    const teamLabel = team?.name || value.team || tr("dispatch.auto");
    return `${tr("dispatch.auto")} · ${teamLabel} · ${obj}`;
  }

  const agent = agents.find((a) => a.id === value.agent);
  const prov = providers.find((p) => p.id === value.provider);
  const agentLabel = agent?.name || value.agent || tr("dispatch.manual");
  const provLabel = prov?.name || value.provider || "";
  const modelLabel = value.model || "";
  return `${tr("dispatch.manual")} · ${agentLabel}${provLabel ? ` · ${provLabel}` : ""}${modelLabel ? ` · ${modelLabel}` : ""}`;
}

export function DispatchSelector({
  value,
  onChange,
  disabled,
  onPreviewBlocked,
  prompt,
  routine,
}: Props) {
  const tr = useT();
  // A finger needs 44px at every width; a mouse does not. The viewport is the
  // wrong question — an iPad is ≥640px wide and still a thumb — so the compact
  // chip is the fine-pointer shape, not the `sm:` shape.
  const coarse = useCoarsePointer();
  const [options, setOptions] = useState<RoutingOptions | null>(null);
  const [preview, setPreview] = useState<RoutingPreview | null>(null);
  const [loading, setLoading] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const [showPreview, setShowPreview] = useState(false);
  const [open, setOpen] = useState(false);
  const popoverId = useId();
  const triggerRef = useRef<HTMLButtonElement>(null);

  const loadOptions = useCallback(async () => {
    try {
      const opts = await getRoutingOptions();
      setOptions(opts);
    } catch {
      // ignore
    }
  }, []);

  useEffect(() => {
    void loadOptions();
  }, [loadOptions]);

  // Outside press, Escape, one layer at a time, focus into the panel and back,
  // and Tab containment belong to the `Popover` layer below. A picker opened
  // from inside this panel portals its surface out of this layer; the desktop
  // list is a nested `Popover` and already inside this layer's reach, while
  // the phone's option sheet is a `Sheet`, so it needs the explicit guards
  // below.
  //
  // This panel is also opened from inside the phone run settings `Sheet`. Its
  // option pickers then open a `Sheet` of their own, portaled out of this
  // layer, and the sheet stack — not `Popover` — owns Escape and Back there.
  // Registering this panel as a sheet layer, while no other sheet sits above
  // it, is what makes one Escape/Back close the option sheet, the next this
  // panel, and the next the run settings behind it.
  const sheets = useSyncExternalStore(subscribeSheets, sheetCount, () => 0);
  const overSheet = open && sheets === 1;
  useSheetLayer(overSheet, () => setOpen(false));

  // The phone's option sheet is not a popover, so a press on one of its rows
  // reads as an outside press to the shared layer: it would close this panel
  // — unmounting the option sheet — before the row's click landed. Keep this
  // panel alive for that press. A vetoed close is cleared on release so the
  // next Escape or outside press still closes the panel.
  const pressInOptionLayer = useRef(false);
  useEffect(() => {
    if (!open) return;
    const onPointerDown = (event: PointerEvent) => {
      const target = event.target as Element | null;
      pressInOptionLayer.current = Boolean(
        target?.closest?.("[data-search-panel], [data-kin-sheet]"),
      );
    };
    const release = () => {
      pressInOptionLayer.current = false;
    };
    document.addEventListener("pointerdown", onPointerDown, true);
    document.addEventListener("pointerup", release, true);
    document.addEventListener("pointercancel", release, true);
    return () => {
      document.removeEventListener("pointerdown", onPointerDown, true);
      document.removeEventListener("pointerup", release, true);
      document.removeEventListener("pointercancel", release, true);
      pressInOptionLayer.current = false;
    };
  }, [open]);

  const handleOpenChange = useCallback((next: boolean) => {
    if (!next && pressInOptionLayer.current) {
      pressInOptionLayer.current = false;
      return;
    }
    setOpen(next);
  }, []);

  // Fetch preview when selection changes and popover is open.
  useEffect(() => {
    if (!value.mode || !open) return;
    setLoading(true);
    setError(null);
    const params: Record<string, string> = { mode: value.mode };
    if (value.mode === "auto") {
      if (value.team) params.team = value.team;
      if (value.objective) params.objective = value.objective;
      if (prompt) params.prompt = prompt;
      if (routine) params.routine = "1";
    } else if (value.mode === "manual") {
      if (value.agent) params.agent = value.agent;
      if (value.provider) params.provider = value.provider;
      if (value.model) params.model = value.model;
    }
    const timer = setTimeout(async () => {
      try {
        const p = await getRoutingPreview(params as any);
        setPreview(p);
      } catch (e) {
        setError(String(e));
        setPreview(null);
      } finally {
        setLoading(false);
      }
    }, 300);
    return () => clearTimeout(timer);
  }, [value, open, prompt, routine]);

  // Report preview blocked status to parent.
  useEffect(() => {
    if (onPreviewBlocked) {
      onPreviewBlocked(!!preview?.blocked);
    }
  }, [preview, onPreviewBlocked]);

  const mode = value.mode || "auto";
  const teams = options?.teams ?? [];
  const agents = options?.agents ?? [];
  const providers = options?.providers ?? [];

  const compatibleProviders = providers.filter((p) => {
    if (!p.enabled) return false;
    if (!value.agent) return true;
    // Check agent support and kind capability.
    const agentOpt = agents.find((a) => a.id === value.agent);
    if (agentOpt && agentOpt.supported_kinds && !agentOpt.supported_kinds.includes(p.kind as any))
      return false;
    return p.supports_agents.includes(value.agent);
  });

  // Get model list for the selected provider (for manual mode dropdown).
  const selectedProvider = providers.find((p) => p.id === value.provider);
  const providerModels = selectedProvider?.models ?? [];

  const enabledTeams = teams.filter((t) => t.enabled);

  const teamOptions: SearchSelectOption[] = [
    { id: "", label: tr("settings.routing.defaultTeamPlaceholder") },
    ...enabledTeams.map((t) => ({ id: t.id, label: `${t.name} (${t.id})` })),
  ];
  const objectiveOptions: SearchSelectOption[] = [
    { id: "balanced", label: tr("settings.routing.objectiveBalanced") },
    { id: "cost-min", label: tr("settings.routing.objectiveCostMin") },
    { id: "intelligent-max", label: tr("settings.routing.objectiveIntelligentMax") },
  ];
  const agentOptions: SearchSelectOption[] = [
    { id: "", label: tr("dispatch.agentPlaceholder") },
    ...agents.map((a) => ({ id: a.id, label: `${a.name} (${a.id})` })),
  ];
  const providerOptions: SearchSelectOption[] = [
    { id: "", label: tr("dispatch.providerPlaceholder") },
    ...compatibleProviders.map((p) => ({ id: p.id, label: `${p.name} (${p.id})` })),
  ];
  const modelOptions: SearchSelectOption[] = [
    { id: "", label: tr("dispatch.modelPlaceholder") },
    ...providerModels.map((m: ModelSpec) => ({ id: m.id, label: `${m.id} (${m.tier || "?"})` })),
  ];

  // Compact summary for the trigger button.
  const summary = getDispatchSummary(value, options, tr);

  return (
    <div className="relative inline-flex items-center">
      {/* The trigger is the phone's tap target for this whole panel, so its
          own box holds the 44px floor (`min-h-11! min-w-11`) rather than a
          wrapper or a pseudo-element the journey walk cannot measure. The
          compact 28px chip returns for a fine pointer only (a Mac), so the
          Mac row heights do not move while an iPad keeps the touch size. The
          `!` holds either height over the facade's own `sm:` zero floor. */}
      <Button
        ref={triggerRef}
        variant="quiet"
        disabled={disabled}
        onClick={() => setOpen((v) => !v)}
        aria-haspopup="dialog"
        aria-expanded={open}
        aria-controls={open ? popoverId : undefined}
        className={`text-caption font-medium px-2 py-1 rounded border truncate max-w-[220px] [&>span]:min-w-0 [&>span>span]:truncate ${
          coarse ? "min-h-11! min-w-11" : "min-h-7! min-w-0"
        } ${
          open
            ? "border-kin-blue bg-kin-blue/10! text-kin-blue-ink!"
            : "border-[var(--kin-hairline)] text-kin-secondary! hover:bg-[var(--kin-fill)]"
        }`}
        title={summary}
      >
        {summary}
      </Button>

      <Popover
        open={open}
        onOpenChange={handleOpenChange}
        triggerRef={triggerRef}
        label={tr("dispatch.popoverLabel")}
        id={popoverId}
        placement="above"
        align="right"
        width={320}
        maxHeight={360}
      >
        {/* `data-sheet-layer` while this panel is the layer over the one open
            sheet: the sheet's Escape/Tab handling finds it without a portal
            walk, so it declines to close underneath this panel. It is off
            when another sheet is above (the panel is below it) and when no
            sheet is open (a desktop popover is nobody's sheet layer). */}
        <div
          data-sheet-layer={overSheet ? "" : undefined}
          className="text-body leading-4 space-y-2"
        >
          {/* Mode toggle */}
          <div className="flex items-center gap-1">
            <Button
              variant={mode === "auto" ? "default" : "secondary"}
              disabled={disabled}
              onClick={() => onChange({ mode: "auto" })}
              aria-pressed={mode === "auto"}
              // The mode pair is a tap target on the phone's panel too. The
              // `!` holds the floor over the facade's own `sm:` zero-floor
              // variant, which would otherwise win at an iPad's width.
              className={`text-caption font-medium ${coarse ? "min-h-11! px-3 py-2" : "min-h-7 px-2 py-1"}`}
            >
              {tr("dispatch.auto")}
            </Button>
            <Button
              variant={mode === "manual" ? "default" : "secondary"}
              disabled={disabled}
              onClick={() => onChange({ mode: "manual" })}
              aria-pressed={mode === "manual"}
              className={`text-caption font-medium ${coarse ? "min-h-11! px-3 py-2" : "min-h-7 px-2 py-1"}`}
            >
              {tr("dispatch.manual")}
            </Button>
          </div>

          {/* Auto mode */}
          {mode === "auto" && (
            <div className="space-y-1.5">
              <SearchSelect
                variant="field"
                searchable
                label={tr("settings.routing.defaultTeam")}
                value={value.team || ""}
                options={teamOptions}
                onChange={(team) => onChange({ mode: "auto", team, objective: value.objective })}
                disabled={disabled}
              />
              <SearchSelect
                variant="field"
                label={tr("settings.routing.objective")}
                value={value.objective || "balanced"}
                options={objectiveOptions}
                onChange={(objective) => onChange({ mode: "auto", team: value.team, objective })}
                disabled={disabled}
              />
            </div>
          )}

          {/* Manual mode */}
          {mode === "manual" && (
            <div className="space-y-1.5">
              <SearchSelect
                variant="field"
                searchable
                label={tr("dispatch.agentPlaceholder")}
                value={value.agent || ""}
                options={agentOptions}
                onChange={(agent) => onChange({ mode: "manual", agent })}
                disabled={disabled}
              />
              <SearchSelect
                variant="field"
                searchable
                label={tr("dispatch.providerPlaceholder")}
                value={value.provider || ""}
                options={providerOptions}
                onChange={(provider) =>
                  onChange({
                    mode: "manual",
                    agent: value.agent,
                    provider,
                    model: "",
                  })
                }
                disabled={disabled || !value.agent}
              />
              {/* Model: dropdown from provider's model list */}
              {providerModels.length > 0 ? (
                <SearchSelect
                  variant="field"
                  searchable
                  label={tr("dispatch.modelPlaceholder")}
                  value={value.model || ""}
                  options={modelOptions}
                  onChange={(model) =>
                    onChange({
                      mode: "manual",
                      agent: value.agent,
                      provider: value.provider,
                      model,
                    })
                  }
                  disabled={disabled || !value.provider}
                />
              ) : value.provider ? (
                <div className="text-body leading-4 text-kin-orange-ink px-1">
                  {tr("dispatch.noModels")}
                </div>
              ) : null}
            </div>
          )}

          {/* Preview toggle */}
          {(mode === "auto" && value.team) ||
          (mode === "manual" && value.agent && value.provider && value.model) ? (
            <Button
              variant="quiet"
              onClick={() => setShowPreview((v) => !v)}
              className={`text-micro text-kin-blue-ink! hover:underline ${
                coarse ? "inline-flex min-h-11! items-center" : ""
              }`}
            >
              {showPreview ? tr("dispatch.hidePreview") : tr("dispatch.showPreview")}
            </Button>
          ) : null}

          {showPreview && (
            <div className="rounded border border-[var(--kin-hairline)] p-2 space-y-1 bg-[var(--kin-fill)]">
              {loading && (
                <span className="text-micro text-kin-muted">{tr("dispatch.loadingPreview")}</span>
              )}
              {error && <span className="text-micro text-kin-red-ink">{error}</span>}
              {preview?.blocked && (
                <span className="text-micro text-kin-red-ink block">
                  {preview.blocked_reason || tr("settings.routing.blocked")}
                </span>
              )}
              {preview?.phases.map((p) => (
                <div key={p.phase} className="flex items-center gap-2 text-micro">
                  <span className="font-mono font-semibold text-kin-secondary w-14">{p.phase}</span>
                  <span
                    className={`${p.status === "resolved" ? "text-kin-green-ink" : p.status === "blocked" ? "text-kin-red-ink" : "text-kin-muted"}`}
                  >
                    {p.status === "resolved"
                      ? `${p.agent} · ${p.provider} · ${p.model}`
                      : formatPreviewStatus(p.status, tr)}
                  </span>
                </div>
              ))}
            </div>
          )}
        </div>
      </Popover>
    </div>
  );
}

// Default dispatch selection: empty mode means routing is not configured.
export function defaultDispatchSelection(): DispatchSelection {
  return {};
}

// Whether the dispatch selection is complete enough to submit.
// When previewBlocked is true, the selection is not ready even if fields are filled.
export function isDispatchReady(sel: DispatchSelection, previewBlocked?: boolean): boolean {
  if (!sel.mode) return true;
  if (previewBlocked) return false;
  if (sel.mode === "auto") return !!sel.team;
  if (sel.mode === "manual") return !!sel.agent && !!sel.provider && !!sel.model;
  return false;
}

/**
 * Whether a dispatch selection should stop a send before it reaches the API.
 *
 * A task aimed at another machine never carries dispatch — it is the Hub's own
 * routing and does not cross machines — so the selection cannot be a
 * precondition for it. It used to be, and that was a dead end: a default team
 * from settings leaves `mode` at "auto" for the whole draft, and the remote
 * path hides the dispatch control entirely, so there was no way to clear the
 * selection and every remote send failed with "dispatch incomplete". Same
 * reasoning as the `!(dispatchReady && !remote)` spread at the call site:
 * readiness and relevance are two questions.
 */
export function dispatchBlocksSend(
  sel: DispatchSelection,
  { remote = false, previewBlocked = false }: { remote?: boolean; previewBlocked?: boolean } = {},
): boolean {
  if (remote) return false;
  return !!sel.mode && !isDispatchReady(sel, previewBlocked);
}
