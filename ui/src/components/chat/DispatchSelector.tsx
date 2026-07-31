import { useCallback, useEffect, useRef, useState } from "react";
import {
  getRoutingOptions,
  getRoutingPreview,
  type RoutingOptions,
  type RoutingPreview,
  type ModelSpec,
} from "../../api/client";
import { useT } from "../../i18n/react";

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
};

export function DispatchSelector({ value, onChange, disabled, onPreviewBlocked }: Props) {
  const tr = useT();
  const [options, setOptions] = useState<RoutingOptions | null>(null);
  const [preview, setPreview] = useState<RoutingPreview | null>(null);
  const [loading, setLoading] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const [showPreview, setShowPreview] = useState(false);
  const [open, setOpen] = useState(false);
  const popRef = useRef<HTMLDivElement>(null);
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

  // Close popover on outside click.
  useEffect(() => {
    if (!open) return;
    const handler = (e: MouseEvent) => {
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

  // Fetch preview when selection changes and popover is open.
  useEffect(() => {
    if (!value.mode || !open) return;
    setLoading(true);
    setError(null);
    const params: Record<string, string> = { mode: value.mode };
    if (value.mode === "auto") {
      if (value.team) params.team = value.team;
      if (value.objective) params.objective = value.objective;
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
  }, [value, open]);

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
    if (agentOpt && agentOpt.supported_kinds && !agentOpt.supported_kinds.includes(p.kind as any)) return false;
    return p.supports_agents.includes(value.agent);
  });

  // Get model list for the selected provider (for manual mode dropdown).
  const selectedProvider = providers.find((p) => p.id === value.provider);
  const providerModels = selectedProvider?.models ?? [];

  const enabledTeams = teams.filter((t) => t.enabled);

  // Compact summary for the trigger button.
  const summary = (() => {
    if (!value.mode) return "Dispatch";
    if (mode === "auto") {
      const team = teams.find((t) => t.id === value.team);
      const obj = value.objective || "balanced";
      const teamLabel = team?.name || value.team || "Auto";
      return `Auto · ${teamLabel} · ${obj}`;
    }
    const agent = agents.find((a) => a.id === value.agent);
    const prov = providers.find((p) => p.id === value.provider);
    const agentLabel = agent?.name || value.agent || "Manual";
    const provLabel = prov?.name || value.provider || "";
    const modelLabel = value.model || "";
    return `Manual · ${agentLabel}${provLabel ? ` · ${provLabel}` : ""}${modelLabel ? ` · ${modelLabel}` : ""}`;
  })();

  return (
    <div className="relative inline-flex items-center">
      <button
        ref={triggerRef}
        type="button"
        disabled={disabled}
        onClick={() => setOpen((v) => !v)}
        className={`text-[11px] font-medium px-2 py-1 rounded min-h-[28px] border truncate max-w-[220px] ${
          open
            ? "border-kin-blue bg-kin-blue/10 text-kin-blue"
            : "border-[var(--kin-hairline)] text-kin-secondary hover:bg-[var(--kin-fill)]"
        }`}
        title={summary}
      >
        {summary}
      </button>

      {/* Popover */}
      {open && (
        <div
          ref={popRef}
          className="absolute bottom-full left-0 mb-2 z-50 rounded-lg border border-[var(--kin-hairline)] bg-kin-surface p-3 shadow-lg min-w-[240px] max-w-[320px]"
        >
          <div className="text-xs space-y-2">
            {/* Mode toggle */}
            <div className="flex items-center gap-1">
              <button
                type="button"
                disabled={disabled}
                onClick={() => onChange({ mode: "auto" })}
                className={`px-2 py-1 rounded text-[11px] font-medium min-h-[26px] ${
                  mode === "auto"
                    ? "bg-kin-blue text-white"
                    : "border border-[var(--kin-hairline)] text-kin-secondary hover:bg-[var(--kin-fill)]"
                }`}
              >
                Auto
              </button>
              <button
                type="button"
                disabled={disabled}
                onClick={() => onChange({ mode: "manual" })}
                className={`px-2 py-1 rounded text-[11px] font-medium min-h-[26px] ${
                  mode === "manual"
                    ? "bg-kin-blue text-white"
                    : "border border-[var(--kin-hairline)] text-kin-secondary hover:bg-[var(--kin-fill)]"
                }`}
              >
                Manual
              </button>
            </div>

            {/* Auto mode */}
            {mode === "auto" && (
              <div className="space-y-1.5">
                <select
                  value={value.team || ""}
                  onChange={(e) => onChange({ mode: "auto", team: e.target.value, objective: value.objective })}
                  disabled={disabled}
                  className="kin-input min-h-[32px] text-xs w-full"
                >
                  <option value="">{tr("settings.routing.defaultTeamPlaceholder")}</option>
                  {enabledTeams.map((t) => (
                    <option key={t.id} value={t.id}>
                      {t.name} ({t.id})
                    </option>
                  ))}
                </select>
                <select
                  value={value.objective || "balanced"}
                  onChange={(e) => onChange({ mode: "auto", team: value.team, objective: e.target.value })}
                  disabled={disabled}
                  className="kin-input min-h-[32px] text-xs w-full"
                >
                  <option value="balanced">{tr("settings.routing.objectiveBalanced")}</option>
                  <option value="cost-min">{tr("settings.routing.objectiveCostMin")}</option>
                  <option value="intelligent-max">{tr("settings.routing.objectiveIntelligentMax")}</option>
                </select>
              </div>
            )}

            {/* Manual mode */}
            {mode === "manual" && (
              <div className="space-y-1.5">
                <select
                  value={value.agent || ""}
                  onChange={(e) => onChange({ mode: "manual", agent: e.target.value })}
                  disabled={disabled}
                  className="kin-input min-h-[32px] text-xs w-full"
                >
                  <option value="">Agent…</option>
                  {agents.map((a) => (
                    <option key={a.id} value={a.id}>
                      {a.name} ({a.id})
                    </option>
                  ))}
                </select>
                <select
                  value={value.provider || ""}
                  onChange={(e) => onChange({ mode: "manual", agent: value.agent, provider: e.target.value, model: "" })}
                  disabled={disabled || !value.agent}
                  className="kin-input min-h-[32px] text-xs w-full"
                >
                  <option value="">Provider…</option>
                  {compatibleProviders.map((p) => (
                    <option key={p.id} value={p.id}>
                      {p.name} ({p.id})
                    </option>
                  ))}
                </select>
                {/* Model: dropdown from provider's model list */}
                {providerModels.length > 0 ? (
                  <select
                    value={value.model || ""}
                    onChange={(e) => onChange({ mode: "manual", agent: value.agent, provider: value.provider, model: e.target.value })}
                    disabled={disabled || !value.provider}
                    className="kin-input min-h-[32px] text-xs w-full"
                  >
                    <option value="">Model…</option>
                    {providerModels.map((m: ModelSpec) => (
                      <option key={m.id} value={m.id}>
                        {m.id} ({m.tier || "?"})
                      </option>
                    ))}
                  </select>
                ) : value.provider ? (
                  <div className="text-xs text-[var(--kin-warning)] px-1">No models listed for this provider</div>
                ) : null}
              </div>
            )}

            {/* Preview toggle */}
            {(mode === "auto" && value.team) || (mode === "manual" && value.agent && value.provider && value.model) ? (
              <button
                type="button"
                onClick={() => setShowPreview((v) => !v)}
                className="text-[10px] text-kin-blue hover:underline"
              >
                {showPreview ? "Hide preview" : "Show preview"}
              </button>
            ) : null}

            {showPreview && (
              <div className="rounded border border-[var(--kin-hairline)] p-2 space-y-1 bg-[var(--kin-fill)]/40">
                {loading && <span className="text-[10px] text-kin-muted">Loading preview…</span>}
                {error && <span className="text-[10px] text-kin-red">{error}</span>}
                {preview?.blocked && (
                  <span className="text-[10px] text-kin-red block">
                    {preview.blocked_reason || tr("settings.routing.blocked")}
                  </span>
                )}
                {preview?.phases.map((p) => (
                  <div key={p.phase} className="flex items-center gap-2 text-[10px]">
                    <span className="font-mono font-semibold text-kin-secondary w-14">{p.phase}</span>
                    <span className={`${p.status === "resolved" ? "text-kin-green" : p.status === "blocked" ? "text-kin-red" : "text-kin-muted"}`}>
                      {p.status === "resolved" ? `${p.agent} · ${p.provider} · ${p.model}` : p.status}
                    </span>
                  </div>
                ))}
              </div>
            )}
          </div>
        </div>
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
