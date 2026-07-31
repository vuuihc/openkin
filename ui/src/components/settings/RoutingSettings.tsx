import { useCallback, useEffect, useState } from "react";
import {
  ApiError,
  getRoutingDefaults,
  getRoutingOptions,
  getRoutingProfiles,
  updateRoutingDefaults,
  updateRoutingProfiles,
  type RoutingOptions,
  type RoutingTeamProfile,
  type RoutingPhasePolicy,
} from "../../api/client";
import { useT } from "../../i18n/react";

// ---------------------------------------------------------------------------
// Routing Defaults Section
// ---------------------------------------------------------------------------

export function RoutingDefaultsSection() {
  const tr = useT();
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const [saved, setSaved] = useState(false);

  const [options, setOptions] = useState<RoutingOptions | null>(null);
  const [enabled, setEnabled] = useState(false);
  const [defaultTeam, setDefaultTeam] = useState("");
  const [objective, setObjective] = useState("balanced");
  const [maxAttempts, setMaxAttempts] = useState(3);
  const [terminalPolicy, setTerminalPolicy] = useState("ask");
  const [manualFallback, setManualFallback] = useState(false);

  const load = useCallback(async () => {
    try {
      const [d, o] = await Promise.all([
        getRoutingDefaults(),
        getRoutingOptions(),
      ]);
      setOptions(o);
      setEnabled(d.enabled);
      setDefaultTeam(d.default_team);
      setObjective(d.objective || "balanced");
      setMaxAttempts(d.max_attempts_per_step);
      setTerminalPolicy(d.terminal_limit_policy || "ask");
      setManualFallback(d.manual_fallback);
    } catch {
      // ignore
    }
  }, []);

  useEffect(() => {
    void load();
  }, [load]);

  const save = async () => {
    setBusy(true);
    setError(null);
    setSaved(false);
    try {
      await updateRoutingDefaults({
        enabled,
        default_team: defaultTeam,
        objective,
        max_attempts_per_step: maxAttempts,
        terminal_limit_policy: terminalPolicy,
        manual_fallback: manualFallback,
      });
      setSaved(true);
    } catch (e) {
      setError(e instanceof ApiError ? e.message : String(e));
    } finally {
      setBusy(false);
    }
  };

  return (
    <section className="rounded-xl border border-[var(--kin-hairline)] bg-kin-elevated/60 p-4 space-y-4">
      <h2 className="text-[11px] font-semibold uppercase tracking-wide text-kin-muted">
        {tr("settings.routing.heading")}
      </h2>
      <p className="text-xs text-kin-muted">{tr("settings.routing.desc")}</p>

      <label className="flex items-center gap-2 cursor-pointer">
        <input
          type="checkbox"
          checked={enabled}
          onChange={(e) => setEnabled(e.target.checked)}
          className="mt-1"
        />
        <span className="space-y-0.5">
          <span className="block text-xs font-medium text-kin-secondary">
            {tr("settings.routing.enabled")}
          </span>
          <span className="block text-[11px] text-kin-muted">
            {tr("settings.routing.enabledHint")}
          </span>
        </span>
      </label>

      {enabled && (
        <>
          <label className="block space-y-1">
            <span className="text-xs font-medium text-kin-secondary">
              {tr("settings.routing.defaultTeam")}
            </span>
            <select
              value={defaultTeam}
              onChange={(e) => setDefaultTeam(e.target.value)}
              className="kin-input min-h-[44px]"
            >
              <option value="">{tr("settings.routing.defaultTeamPlaceholder")}</option>
              {(options?.teams ?? []).map((t) => (
                <option key={t.id} value={t.id}>
                  {t.name} ({t.id})
                </option>
              ))}
            </select>
          </label>

          <label className="block space-y-1">
            <span className="text-xs font-medium text-kin-secondary">
              {tr("settings.routing.objective")}
            </span>
            <select
              value={objective}
              onChange={(e) => setObjective(e.target.value)}
              className="kin-input min-h-[44px]"
            >
              <option value="balanced">{tr("settings.routing.objectiveBalanced")}</option>
              <option value="cost-min">{tr("settings.routing.objectiveCostMin")}</option>
              <option value="intelligent-max">{tr("settings.routing.objectiveIntelligentMax")}</option>
            </select>
          </label>

          <label className="block space-y-1">
            <span className="text-xs font-medium text-kin-secondary">
              {tr("settings.routing.maxAttempts")}
            </span>
            <input
              type="number"
              min={1}
              max={10}
              value={maxAttempts}
              onChange={(e) => setMaxAttempts(Number(e.target.value))}
              className="kin-input min-h-[44px]"
            />
          </label>

          <label className="block space-y-1">
            <span className="text-xs font-medium text-kin-secondary">
              {tr("settings.routing.terminalPolicy")}
            </span>
            <select
              value={terminalPolicy}
              onChange={(e) => setTerminalPolicy(e.target.value)}
              className="kin-input min-h-[44px]"
            >
              <option value="wait">{tr("settings.routing.wait")}</option>
              <option value="ask">{tr("settings.routing.ask")}</option>
              <option value="switch">{tr("settings.routing.switch")}</option>
            </select>
          </label>

          <label className="flex items-center gap-2 cursor-pointer">
            <input
              type="checkbox"
              checked={manualFallback}
              onChange={(e) => setManualFallback(e.target.checked)}
              className="mt-1"
            />
            <span className="space-y-0.5">
              <span className="block text-xs font-medium text-kin-secondary">
                {tr("settings.routing.manualFallback")}
              </span>
              <span className="block text-[11px] text-kin-muted">
                {tr("settings.routing.manualFallbackHint")}
              </span>
            </span>
          </label>
        </>
      )}

      <div className="flex items-center gap-3">
        <button
          type="button"
          disabled={busy}
          onClick={() => void save()}
          className="kin-btn-primary disabled:opacity-50"
        >
          {busy ? tr("settings.saving") : tr("settings.routing.save")}
        </button>
        {saved && <span className="text-xs text-kin-green">{tr("settings.notify.savedShort")}</span>}
        {error && <span className="text-xs text-kin-red">{error}</span>}
      </div>
    </section>
  );
}

// ---------------------------------------------------------------------------
// Routing Profiles Section
// ---------------------------------------------------------------------------

export function RoutingProfilesSection() {
  const tr = useT();
  const [profiles, setProfiles] = useState<RoutingTeamProfile[]>([]);
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const [editing, setEditing] = useState<RoutingTeamProfile | null>(null);
  const [isNew, setIsNew] = useState(false);

  const load = useCallback(async () => {
    try {
      const res = await getRoutingProfiles();
      setProfiles(res.profiles ?? []);
    } catch {
      // ignore
    }
  }, []);

  useEffect(() => {
    void load();
  }, [load]);

  const addProfile = () => {
    setEditing({
      id: "",
      name: "",
      alias: "",
      enabled: true,
      phases: {},
    });
    setIsNew(true);
  };

  const editProfile = (p: RoutingTeamProfile) => {
    setEditing({ ...p, phases: { ...p.phases } });
    setIsNew(false);
  };

  // Generate a slug from the profile name (e.g. "My Team" → "my-team").
  const slugFromName = (name: string) =>
    name
      .toLowerCase()
      .replace(/[^a-z0-9]+/g, "-")
      .replace(/^-+|-+$/g, "")
      .slice(0, 64);

  const deleteProfile = (id: string) => {
    if (!window.confirm(tr("settings.routing.confirmDelete"))) return;
    const next = profiles.filter((p) => p.id !== id);
    setProfiles(next);
    updateRoutingProfiles(next)
      .then((res) => setProfiles(res.profiles ?? []))
      .catch(() => setProfiles(profiles)); // revert on error
  };

  const updatePhase = (phase: string, field: keyof RoutingPhasePolicy, value: string | string[]) => {
    if (!editing) return;
    const updated = { ...editing };
    updated.phases = { ...updated.phases };
    updated.phases[phase] = { ...(updated.phases[phase] || { agent: "", tier: "balanced", provider_priority: [], fallback: [] }), [field]: value };
    setEditing(updated);
  };

  const addPhase = (phase: string) => {
    if (!editing) return;
    const updated = { ...editing };
    updated.phases = { ...updated.phases, [phase]: { agent: "", tier: "balanced", provider_priority: [], fallback: [] } };
    setEditing(updated);
  };

  const removePhase = (phase: string) => {
    if (!editing) return;
    const updated = { ...editing };
    updated.phases = { ...updated.phases };
    delete updated.phases[phase];
    setEditing(updated);
  };

  return (
    <section className="rounded-xl border border-[var(--kin-hairline)] bg-kin-elevated/60 p-4 space-y-4">
      <div className="flex items-start justify-between gap-3">
        <div className="space-y-1 min-w-0">
          <h2 className="text-[11px] font-semibold uppercase tracking-wide text-kin-muted">
            {tr("settings.routing.profiles")}
          </h2>
          <p className="text-[12px] text-kin-secondary leading-relaxed">
            {tr("settings.routing.profilesDesc")}
          </p>
        </div>
        <button
          type="button"
          onClick={addProfile}
          className="kin-btn-secondary shrink-0 disabled:opacity-50"
        >
          {tr("settings.routing.addProfile")}
        </button>
      </div>

      {profiles.length === 0 && !editing ? (
        <p className="text-[13px] text-kin-muted">{tr("settings.routing.noTeams")}</p>
      ) : (
        <ul className="space-y-2">
          {profiles.map((p) => (
            <li
              key={p.id}
              className="rounded-lg border border-[var(--kin-hairline)] bg-[var(--kin-fill)]/40 p-3 flex flex-col sm:flex-row sm:items-center gap-3"
            >
              <div className="min-w-0 flex-1 space-y-0.5">
                <div className="flex items-center gap-2 flex-wrap">
                  <span className="text-[13px] font-medium truncate">{p.name}</span>
                  {p.alias && (
                    <span className="text-[10px] font-mono text-kin-muted">{p.alias}</span>
                  )}
                  <span className={`text-[10px] font-semibold uppercase tracking-wide ${p.enabled ? "text-kin-green" : "text-kin-muted"}`}>
                    {p.enabled ? "enabled" : "disabled"}
                  </span>
                </div>
                <p className="text-[11px] text-kin-muted font-mono truncate">
                  {p.id} · {Object.keys(p.phases).length} phase(s) · {p.default_objective || "balanced"}
                </p>
              </div>
              <div className="flex flex-wrap gap-2 shrink-0">
                <button
                  type="button"
                  onClick={() => editProfile(p)}
                  className="kin-btn-secondary text-[12px] min-h-[36px]"
                >
                  {tr("settings.provider.edit")}
                </button>
                <button
                  type="button"
                  onClick={() => deleteProfile(p.id)}
                  className="kin-btn-secondary text-[12px] min-h-[36px] text-kin-red"
                >
                  {tr("settings.provider.delete")}
                </button>
              </div>
            </li>
          ))}
        </ul>
      )}

      {/* Editing form */}
      {editing && (
        <div className="rounded-lg border border-[var(--kin-hairline)] p-3 space-y-3 bg-kin-elevated">
          <h3 className="text-[12px] font-semibold text-kin-secondary">
            {isNew ? "New profile" : "Edit profile"}
          </h3>
          <label className="block space-y-1">
            <span className="text-xs font-medium text-kin-secondary">{tr("settings.routing.profileId")}</span>
            <input
              type="text"
              value={editing.id}
              onChange={(e) => setEditing({ ...editing, id: e.target.value })}
              className="kin-input min-h-[44px] font-mono text-xs"
              disabled={!isNew}
              placeholder={isNew ? slugFromName(editing.name) || "auto-generated" : ""}
            />
            {isNew && (
              <span className="text-[10px] text-kin-muted">
                ID will be auto-generated from the name if left empty
              </span>
            )}
          </label>
          <label className="block space-y-1">
            <span className="text-xs font-medium text-kin-secondary">{tr("settings.routing.profileName")}</span>
            <input
              type="text"
              value={editing.name}
              onChange={(e) => {
                const name = e.target.value;
                setEditing({
                  ...editing,
                  name,
                  // Auto-fill ID from name for new profiles.
                  id: isNew && !editing.id ? slugFromName(name) : editing.id,
                });
              }}
              className="kin-input min-h-[44px]"
            />
          </label>
          <label className="block space-y-1">
            <span className="text-xs font-medium text-kin-secondary">{tr("settings.routing.alias")}</span>
            <input
              type="text"
              value={editing.alias || ""}
              onChange={(e) => setEditing({ ...editing, alias: e.target.value })}
              className="kin-input min-h-[44px] font-mono text-xs"
              placeholder="A"
            />
            <span className="text-[11px] text-kin-muted">{tr("settings.routing.aliasHint")}</span>
          </label>
          <label className="flex items-center gap-2 cursor-pointer">
            <input
              type="checkbox"
              checked={editing.enabled}
              onChange={(e) => setEditing({ ...editing, enabled: e.target.checked })}
            />
            <span className="text-xs text-kin-secondary">{tr("settings.routing.profileEnabled")}</span>
          </label>
          <label className="block space-y-1">
            <span className="text-xs font-medium text-kin-secondary">{tr("settings.routing.defaultObjective")}</span>
            <select
              value={editing.default_objective || "balanced"}
              onChange={(e) => setEditing({ ...editing, default_objective: e.target.value })}
              className="kin-input min-h-[44px]"
            >
              <option value="balanced">{tr("settings.routing.objectiveBalanced")}</option>
              <option value="cost-min">{tr("settings.routing.objectiveCostMin")}</option>
              <option value="intelligent-max">{tr("settings.routing.objectiveIntelligentMax")}</option>
            </select>
          </label>

          {/* Phases */}
          <div className="space-y-2">
            <div className="flex items-center justify-between">
              <span className="text-xs font-medium text-kin-secondary">Phases</span>
              <div className="flex gap-1">
                {(["plan", "execute", "review", "chat"] as const).map((phase) => (
                  <button
                    key={phase}
                    type="button"
                    disabled={!!editing.phases[phase]}
                    onClick={() => addPhase(phase)}
                    className={`text-[10px] px-1.5 py-0.5 rounded border min-h-[22px] ${
                      editing.phases[phase]
                        ? "border-kin-green bg-kin-green/10 text-kin-green cursor-default"
                        : "border-[var(--kin-hairline)] text-kin-muted hover:text-kin-blue hover:border-kin-blue"
                    }`}
                  >
                    {phase}
                  </button>
                ))}
              </div>
            </div>
            {Object.entries(editing.phases).map(([phase, pp]) => (
              <div key={phase} className="rounded border border-[var(--kin-hairline)] p-2 space-y-2">
                <div className="flex items-center justify-between">
                  <span className="text-[11px] font-mono font-semibold text-kin-secondary">{phase}</span>
                  <button
                    type="button"
                    onClick={() => removePhase(phase)}
                    className="text-[10px] text-kin-red hover:underline"
                  >
                    remove
                  </button>
                </div>
                <label className="block space-y-0.5">
                  <span className="text-[10px] text-kin-muted">{tr("settings.routing.agent")}</span>
                  <input
                    type="text"
                    value={pp.agent}
                    onChange={(e) => updatePhase(phase, "agent", e.target.value)}
                    className="kin-input min-h-[36px] text-xs font-mono"
                    placeholder="claude-code"
                  />
                </label>
                <label className="block space-y-0.5">
                  <span className="text-[10px] text-kin-muted">{tr("settings.routing.tier")}</span>
                  <select
                    value={pp.tier || "balanced"}
                    onChange={(e) => updatePhase(phase, "tier", e.target.value)}
                    className="kin-input min-h-[36px] text-xs"
                  >
                    <option value="smart">smart</option>
                    <option value="balanced">balanced</option>
                    <option value="fast">fast</option>
                  </select>
                </label>
                <label className="block space-y-0.5">
                  <span className="text-[10px] text-kin-muted">{tr("settings.routing.providerPriority")}</span>
                  <input
                    type="text"
                    value={pp.provider_priority.join(", ")}
                    onChange={(e) => updatePhase(phase, "provider_priority", e.target.value.split(",").map((s) => s.trim()).filter(Boolean))}
                    className="kin-input min-h-[36px] text-xs font-mono"
                    placeholder="provider-1, provider-2"
                  />
                </label>
                <label className="block space-y-0.5">
                  <span className="text-[10px] text-kin-muted">{tr("settings.routing.fallback")}</span>
                  <input
                    type="text"
                    value={pp.fallback.join(", ")}
                    onChange={(e) => updatePhase(phase, "fallback", e.target.value.split(",").map((s) => s.trim()).filter(Boolean))}
                    className="kin-input min-h-[36px] text-xs font-mono"
                    placeholder="next_provider_same_tier"
                  />
                </label>
              </div>
            ))}
          </div>

          <div className="flex flex-wrap gap-2">
            <button
              type="button"
              disabled={busy}
              onClick={() => {
                const next = isNew
                  ? [...profiles, editing!]
                  : profiles.map((p) => (p.id === editing!.id ? editing! : p));
                setBusy(true);
                setError(null);
                updateRoutingProfiles(next)
                  .then((res) => {
                    setProfiles(res.profiles ?? []);
                    setEditing(null);
                    setIsNew(false);
                  })
                  .catch((e) => setError(e instanceof ApiError ? e.message : String(e)))
                  .finally(() => setBusy(false));
              }}
              className="kin-btn-primary disabled:opacity-50"
            >
              {busy ? tr("settings.saving") : tr("settings.routing.saveProfile")}
            </button>
            <button
              type="button"
              onClick={() => { setEditing(null); setIsNew(false); }}
              className="kin-btn-secondary"
            >
              {tr("settings.provider.cancel")}
            </button>
          </div>
        </div>
      )}

      <div className="flex items-center gap-3">
        {error && <span className="text-xs text-kin-red">{error}</span>}
      </div>
    </section>
  );
}

// ---------------------------------------------------------------------------
// Team profile phase editor — helpers
// ---------------------------------------------------------------------------

// ValidRoutePhases is the list of known route phases.
export const ValidRoutePhases = ["plan", "execute", "review", "chat"] as const;
