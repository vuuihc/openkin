import { useCallback, useEffect, useId, useRef, useState } from "react";
import { createPortal } from "react-dom";
import {
  getRoutingOptions,
  getRoutingPreview,
  type RoutingOptions,
  type RoutingPreview,
  type ModelSpec,
} from "../../api/client";
import { useAnchoredPanel } from "../../hooks/useAnchoredPanel";
import { useT } from "../../i18n/react";
import SearchSelect, { type SearchSelectOption } from "../ui/SearchSelect";

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
  const [options, setOptions] = useState<RoutingOptions | null>(null);
  const [preview, setPreview] = useState<RoutingPreview | null>(null);
  const [loading, setLoading] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const [showPreview, setShowPreview] = useState(false);
  const [open, setOpen] = useState(false);
  const popoverId = useId();
  const popRef = useRef<HTMLDivElement>(null);
  const triggerRef = useRef<HTMLButtonElement>(null);
  // Viewport coordinates, not `absolute bottom-full`: the composer's control
  // row is an `overflow-x-auto` strip, and CSS computes `overflow-y: auto` from
  // it too, so an absolutely positioned panel is clipped by the strip it lives
  // in. Portaled to <body>, the panel is measured against the viewport and
  // cannot be cut by an ancestor's overflow. `align: "right"` matches the
  // other composer pickers; the hook clamps the panel into the viewport, so on
  // a phone the trigger near the right edge still opens a fully visible panel.
  const anchor = useAnchoredPanel(open, triggerRef, {
    placement: "above",
    align: "right",
    width: 320,
    maxHeight: 360,
  });
  // The panel is portaled to the end of <body>, so it is no longer the next
  // stop in the tab order after the trigger. Move focus into it when it opens,
  // the same way the permission menu does.
  const anchored = Boolean(anchor);

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

  // Close popover on outside click. Its own pickers portal their panels out of
  // this box, so a click inside one of those layers is not "outside".
  useEffect(() => {
    if (!open) return;
    const handler = (e: MouseEvent) => {
      const target = e.target as Element | null;
      if (target?.closest("[data-search-panel], [data-kin-sheet], ion-action-sheet")) return;
      if (
        popRef.current &&
        !popRef.current.contains(e.target as Node) &&
        triggerRef.current &&
        !triggerRef.current.contains(e.target as Node)
      ) {
        setOpen(false);
      }
    };
    document.addEventListener("mousedown", handler);
    return () => document.removeEventListener("mousedown", handler);
  }, [open]);

  useEffect(() => {
    if (!open) return;
    const handler = (e: KeyboardEvent) => {
      if (e.key !== "Escape") return;
      // A picker opened from this panel owns the key while it is up; closing
      // the panel underneath it would take the picker with it.
      if (document.querySelector("[data-search-panel], [data-kin-sheet], ion-action-sheet")) return;
      setOpen(false);
      triggerRef.current?.focus();
    };
    document.addEventListener("keydown", handler);
    return () => document.removeEventListener("keydown", handler);
  }, [open]);

  // The panel mounts a layout effect after the click, so focus waits for the
  // measured anchor; without that the portal never receives focus and Tab would
  // continue through the strip behind it.
  useEffect(() => {
    if (!open || !anchored) return;
    popRef.current?.querySelector<HTMLElement>("button, select")?.focus({ preventScroll: true });
  }, [open, anchored]);

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
      <button
        ref={triggerRef}
        type="button"
        disabled={disabled}
        onClick={() => setOpen((v) => !v)}
        aria-haspopup="dialog"
        aria-expanded={open}
        aria-controls={open ? popoverId : undefined}
        className={`text-caption font-medium px-2 py-1 rounded min-h-7 border truncate max-w-[220px] ${
          open
            ? "border-kin-blue bg-kin-blue/10 text-kin-blue-ink"
            : "border-[var(--kin-hairline)] text-kin-secondary hover:bg-[var(--kin-fill)]"
        }`}
        title={summary}
      >
        {summary}
      </button>

      {/* Popover */}
      {open &&
        anchor &&
        createPortal(
          <div
            id={popoverId}
            ref={popRef}
            role="dialog"
            aria-label={tr("dispatch.popoverLabel")}
            style={{
              left: anchor.left,
              width: anchor.width,
              maxHeight: anchor.maxHeight,
              top: anchor.top,
              bottom: anchor.bottom,
            }}
            className="fixed z-50 overflow-y-auto kin-scroll rounded-lg border border-[var(--kin-hairline)] bg-kin-panel p-3 shadow-e2"
          >
            <div className="text-body leading-4 space-y-2">
              {/* Mode toggle */}
              <div className="flex items-center gap-1">
                <button
                  type="button"
                  disabled={disabled}
                  onClick={() => onChange({ mode: "auto" })}
                  className={`px-2 py-1 rounded text-caption font-medium min-h-7 ${
                    mode === "auto"
                      ? "bg-kin-blue text-kin-on-brand"
                      : "border border-[var(--kin-hairline)] text-kin-secondary hover:bg-[var(--kin-fill)]"
                  }`}
                >
                  {tr("dispatch.auto")}
                </button>
                <button
                  type="button"
                  disabled={disabled}
                  onClick={() => onChange({ mode: "manual" })}
                  className={`px-2 py-1 rounded text-caption font-medium min-h-7 ${
                    mode === "manual"
                      ? "bg-kin-blue text-kin-on-brand"
                      : "border border-[var(--kin-hairline)] text-kin-secondary hover:bg-[var(--kin-fill)]"
                  }`}
                >
                  {tr("dispatch.manual")}
                </button>
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
                    onChange={(team) =>
                      onChange({ mode: "auto", team, objective: value.objective })
                    }
                    disabled={disabled}
                  />
                  <SearchSelect
                    variant="field"
                    label={tr("settings.routing.objective")}
                    value={value.objective || "balanced"}
                    options={objectiveOptions}
                    onChange={(objective) =>
                      onChange({ mode: "auto", team: value.team, objective })
                    }
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
                <button
                  type="button"
                  onClick={() => setShowPreview((v) => !v)}
                  className="text-micro text-kin-blue-ink hover:underline"
                >
                  {showPreview ? tr("dispatch.hidePreview") : tr("dispatch.showPreview")}
                </button>
              ) : null}

              {showPreview && (
                <div className="rounded border border-[var(--kin-hairline)] p-2 space-y-1 bg-[var(--kin-fill)]">
                  {loading && (
                    <span className="text-micro text-kin-muted">
                      {tr("dispatch.loadingPreview")}
                    </span>
                  )}
                  {error && <span className="text-micro text-kin-red-ink">{error}</span>}
                  {preview?.blocked && (
                    <span className="text-micro text-kin-red-ink block">
                      {preview.blocked_reason || tr("settings.routing.blocked")}
                    </span>
                  )}
                  {preview?.phases.map((p) => (
                    <div key={p.phase} className="flex items-center gap-2 text-micro">
                      <span className="font-mono font-semibold text-kin-secondary w-14">
                        {p.phase}
                      </span>
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
          </div>,
          document.body,
        )}
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
