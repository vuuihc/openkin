import { useCallback, useEffect, useRef, useState } from "react";
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
import { useAppStore } from "../../store/appStore";
import Button from "../ui/Button";
import SearchSelect from "../ui/SearchSelect";
import TextInput from "../ui/TextInput";

// ---------------------------------------------------------------------------
// Routing Defaults Section
// ---------------------------------------------------------------------------

type RoutingDefaults = {
  enabled: boolean;
  defaultTeam: string;
  objective: string;
  maxAttempts: number;
  terminalPolicy: string;
  manualFallback: boolean;
  qualityFloor: "" | "light" | "medium" | "heavy";
  forcePhases: string[];
};

function defaultsKey(v: RoutingDefaults): string {
  return JSON.stringify([
    v.enabled,
    v.defaultTeam,
    v.objective,
    v.maxAttempts,
    v.terminalPolicy,
    v.manualFallback,
    v.qualityFloor,
    v.forcePhases,
  ]);
}

function normaliseFloor(value: string | undefined): "" | "light" | "medium" | "heavy" {
  return value === "light" || value === "medium" || value === "heavy" ? value : "";
}

/** The controls before a load answers. This is also the baseline a failed first
 *  load falls back to: with no server value to compare against, an edited row
 *  is still a draft, and calling it clean would let a departure drop it. */
const EMPTY_DEFAULTS: RoutingDefaults = {
  enabled: false,
  defaultTeam: "",
  objective: "balanced",
  maxAttempts: 3,
  terminalPolicy: "ask",
  manualFallback: false,
  qualityFloor: "",
  forcePhases: [],
};

export function RoutingDefaultsSection({
  onDirtyChange,
}: {
  onDirtyChange?: (dirty: boolean) => void;
}) {
  const tr = useT();
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const [saved, setSaved] = useState(false);

  const [options, setOptions] = useState<RoutingOptions | null>(null);
  const [enabled, setEnabled] = useState(EMPTY_DEFAULTS.enabled);
  const [defaultTeam, setDefaultTeam] = useState(EMPTY_DEFAULTS.defaultTeam);
  const [objective, setObjective] = useState(EMPTY_DEFAULTS.objective);
  const [maxAttempts, setMaxAttempts] = useState(EMPTY_DEFAULTS.maxAttempts);
  const [terminalPolicy, setTerminalPolicy] = useState(EMPTY_DEFAULTS.terminalPolicy);
  const [manualFallback, setManualFallback] = useState(EMPTY_DEFAULTS.manualFallback);
  const [qualityFloor, setQualityFloor] = useState<"" | "light" | "medium" | "heavy">(
    EMPTY_DEFAULTS.qualityFloor,
  );
  const [forcePhases, setForcePhases] = useState<string[]>(EMPTY_DEFAULTS.forcePhases);

  // The loaded values, not `options`: switching a team or typing an attempt
  // count must not look like a saved change. The draft key is what the render
  // holds; a save blesses only the values the request carried, so an edit made
  // while that request was out stays dirty. A failed load leaves the empty
  // baseline in place, so the first edit is still a change.
  const [baseline, setBaseline] = useState<string | null>(() => defaultsKey(EMPTY_DEFAULTS));
  const draft: RoutingDefaults = {
    enabled,
    defaultTeam,
    objective,
    maxAttempts,
    terminalPolicy,
    manualFallback,
    qualityFloor,
    forcePhases,
  };
  const draftKey = defaultsKey(draft);
  const dirty = baseline !== null && draftKey !== baseline;

  // What a read may compare against, field by field: the draft as of the last
  // render, and the last server snapshot. A field equal to the snapshot is
  // untouched, so a read may fill it; anything else is the reader's edit and
  // keeps its value even if the answer arrives after it was typed.
  const draftRef = useRef<RoutingDefaults>(draft);
  useEffect(() => {
    draftRef.current = draft;
  });
  const baselineValues = useRef<RoutingDefaults>({ ...EMPTY_DEFAULTS, forcePhases: [] });

  useEffect(() => {
    onDirtyChange?.(dirty);
  }, [dirty, onDirtyChange]);

  // Only the newest read may land: a reconnect while the first page is still
  // out would otherwise let the older answer arrive last and win.
  const loadSeq = useRef(0);
  const load = useCallback(async () => {
    const mine = ++loadSeq.current;
    try {
      const [d, o] = await Promise.all([getRoutingDefaults(), getRoutingOptions()]);
      if (loadSeq.current !== mine) return;
      const server: RoutingDefaults = {
        enabled: d.enabled,
        defaultTeam: d.default_team,
        objective: d.objective || "balanced",
        maxAttempts: d.max_attempts_per_step,
        terminalPolicy: d.terminal_limit_policy || "ask",
        manualFallback: d.manual_fallback,
        qualityFloor: normaliseFloor(d.quality_floor),
        forcePhases: d.force_phases ?? [],
      };
      setOptions(o);
      const now = draftRef.current;
      const before = baselineValues.current;
      const fill = <K extends keyof RoutingDefaults>(key: K): RoutingDefaults[K] =>
        JSON.stringify(now[key]) === JSON.stringify(before[key]) ? server[key] : now[key];
      setEnabled(fill("enabled"));
      setDefaultTeam(fill("defaultTeam"));
      setObjective(fill("objective"));
      setMaxAttempts(fill("maxAttempts"));
      setTerminalPolicy(fill("terminalPolicy"));
      setManualFallback(fill("manualFallback"));
      setQualityFloor(fill("qualityFloor"));
      setForcePhases(fill("forcePhases"));
      // The baseline is the server's own snapshot, never the merged draft:
      // a kept edit must still read as unsaved.
      baselineValues.current = server;
      setBaseline(defaultsKey(server));
    } catch {
      // ignore
    }
  }, []);

  useEffect(() => {
    void load();
  }, [load]);

  // A reconnect re-reads the server under a form that may hold edits; the
  // merge above is what keeps those edits from being overwritten.
  const reconnectGen = useAppStore((s) => s.reconnectGen);
  const seenReconnect = useRef(reconnectGen);
  useEffect(() => {
    if (reconnectGen === seenReconnect.current) return;
    seenReconnect.current = reconnectGen;
    void load();
  }, [reconnectGen, load]);

  const save = async () => {
    setBusy(true);
    setError(null);
    setSaved(false);
    // What this request actually carries. The response must bless these values,
    // not whatever the draft became while the request was in flight — an edit
    // made in that window is still unsaved.
    const sent: RoutingDefaults = {
      enabled,
      defaultTeam,
      objective,
      maxAttempts,
      terminalPolicy,
      manualFallback,
      qualityFloor,
      forcePhases,
    };
    try {
      await updateRoutingDefaults({
        enabled: sent.enabled,
        default_team: sent.defaultTeam,
        objective: sent.objective,
        max_attempts_per_step: sent.maxAttempts,
        terminal_limit_policy: sent.terminalPolicy,
        manual_fallback: sent.manualFallback,
        quality_floor: sent.qualityFloor,
        force_phases: sent.forcePhases,
      });
      baselineValues.current = sent;
      setBaseline(defaultsKey(sent));
      setSaved(true);
    } catch (e) {
      setError(e instanceof ApiError ? e.message : String(e));
    } finally {
      setBusy(false);
    }
  };

  return (
    <section className="rounded-xl bg-kin-elevated/60 p-4 space-y-4">
      <h2 className="text-caption font-semibold uppercase tracking-label text-kin-muted">
        {tr("settings.routing.heading")}
      </h2>
      <p className="text-body leading-4 text-kin-muted">{tr("settings.routing.desc")}</p>

      <label className="flex items-center gap-2 cursor-pointer">
        <input
          type="checkbox"
          checked={enabled}
          onChange={(e) => setEnabled(e.target.checked)}
          className="mt-1"
        />
        <span className="space-y-0.5">
          <span className="block text-body leading-4 font-medium text-kin-secondary">
            {tr("settings.routing.enabled")}
          </span>
          <span className="block text-caption text-kin-muted">
            {tr("settings.routing.enabledHint")}
          </span>
        </span>
      </label>

      {enabled && (
        <>
          <div className="block space-y-1">
            <span className="text-body leading-4 font-medium text-kin-secondary">
              {tr("settings.routing.defaultTeam")}
            </span>
            <SearchSelect
              variant="field"
              label={tr("settings.routing.defaultTeam")}
              value={defaultTeam}
              options={[
                { id: "", label: tr("settings.routing.defaultTeamPlaceholder") },
                ...(options?.teams ?? []).map((t) => ({
                  id: t.id,
                  label: `${t.name} (${t.id})`,
                })),
              ]}
              onChange={setDefaultTeam}
            />
          </div>

          <div className="block space-y-1">
            <span className="text-body leading-4 font-medium text-kin-secondary">
              {tr("settings.routing.objective")}
            </span>
            <SearchSelect
              variant="field"
              label={tr("settings.routing.objective")}
              value={objective}
              options={[
                { id: "balanced", label: tr("settings.routing.objectiveBalanced") },
                { id: "cost-min", label: tr("settings.routing.objectiveCostMin") },
                { id: "intelligent-max", label: tr("settings.routing.objectiveIntelligentMax") },
              ]}
              onChange={setObjective}
            />
          </div>

          <div className="block space-y-1">
            <span className="text-body leading-4 font-medium text-kin-secondary">
              {tr("settings.routing.qualityFloor")}
            </span>
            <SearchSelect
              variant="field"
              label={tr("settings.routing.qualityFloor")}
              value={qualityFloor}
              options={[
                { id: "", label: tr("settings.routing.qualityFloorAdaptive") },
                { id: "light", label: tr("settings.routing.qualityFloorLight") },
                { id: "medium", label: tr("settings.routing.qualityFloorMedium") },
                { id: "heavy", label: tr("settings.routing.qualityFloorHeavy") },
              ]}
              onChange={(next) =>
                setQualityFloor(
                  next === "light" || next === "medium" || next === "heavy" ? next : "",
                )
              }
            />
          </div>

          <fieldset className="space-y-2">
            <legend className="text-body leading-4 font-medium text-kin-secondary">
              {tr("settings.routing.forcePhases")}
            </legend>
            <p className="text-caption text-kin-muted">{tr("settings.routing.forcePhasesHint")}</p>
            <div className="flex flex-wrap gap-4">
              {(["plan", "execute", "review"] as const).map((phase) => (
                <label
                  key={phase}
                  className="flex items-center gap-2 text-body leading-4 text-kin-secondary"
                >
                  <input
                    type="checkbox"
                    checked={forcePhases.includes(phase)}
                    onChange={(e) => {
                      if (e.target.checked) {
                        setForcePhases((current) => [...current, phase]);
                      } else {
                        setForcePhases((current) => current.filter((item) => item !== phase));
                      }
                    }}
                  />
                  {tr(
                    `settings.routing.phase${phase[0].toUpperCase()}${phase.slice(1)}` as "settings.routing.phasePlan",
                  )}
                </label>
              ))}
            </div>
          </fieldset>

          <TextInput
            type="number"
            label={tr("settings.routing.maxAttempts")}
            min={1}
            max={10}
            value={maxAttempts}
            onChange={(e) => setMaxAttempts(Number(e.target.value))}
          />

          <div className="block space-y-1">
            <span className="text-body leading-4 font-medium text-kin-secondary">
              {tr("settings.routing.terminalPolicy")}
            </span>
            <SearchSelect
              variant="field"
              label={tr("settings.routing.terminalPolicy")}
              value={terminalPolicy}
              options={[
                { id: "wait", label: tr("settings.routing.wait") },
                { id: "ask", label: tr("settings.routing.ask") },
                { id: "switch", label: tr("settings.routing.switch") },
              ]}
              onChange={setTerminalPolicy}
            />
          </div>

          <label className="flex items-center gap-2 cursor-pointer">
            <input
              type="checkbox"
              checked={manualFallback}
              onChange={(e) => setManualFallback(e.target.checked)}
              className="mt-1"
            />
            <span className="space-y-0.5">
              <span className="block text-body leading-4 font-medium text-kin-secondary">
                {tr("settings.routing.manualFallback")}
              </span>
              <span className="block text-caption text-kin-muted">
                {tr("settings.routing.manualFallbackHint")}
              </span>
            </span>
          </label>
        </>
      )}

      <div className="flex items-center gap-3">
        <Button disabled={busy} onClick={() => void save()}>
          {busy ? tr("settings.saving") : tr("settings.routing.save")}
        </Button>
        {saved && (
          <span className="text-body leading-4 text-kin-green-ink">
            {tr("settings.savedShort")}
          </span>
        )}
        {error && <span className="text-body leading-4 text-kin-red-ink">{error}</span>}
      </div>
    </section>
  );
}

// ---------------------------------------------------------------------------
// Routing Profiles Section
// ---------------------------------------------------------------------------

export function RoutingProfilesSection({
  onDirtyChange,
}: {
  onDirtyChange?: (dirty: boolean) => void;
}) {
  const tr = useT();
  const [profiles, setProfiles] = useState<RoutingTeamProfile[]>([]);
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const [editing, setEditing] = useState<RoutingTeamProfile | null>(null);
  const [isNew, setIsNew] = useState(false);

  // The profile as it was when the editor opened. `editing` also changes when
  // the name auto-fills the id, so comparing against the initially opened
  // copy, not a fresh parse of the current draft, is what separates an edit
  // from a reload.
  const [baseline, setBaseline] = useState<string | null>(null);
  const dirty = editing !== null && baseline !== null && JSON.stringify(editing) !== baseline;

  useEffect(() => {
    onDirtyChange?.(dirty);
  }, [dirty, onDirtyChange]);

  // Closing the editor (save or cancel) drops the baseline with it; the next
  // open seeds a fresh one in addProfile/editProfile.
  useEffect(() => {
    if (editing === null) setBaseline(null);
  }, [editing]);

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
    const next: RoutingTeamProfile = {
      id: "",
      name: "",
      alias: "",
      enabled: true,
      phases: {},
    };
    setBaseline(JSON.stringify(next));
    setEditing(next);
    setIsNew(true);
  };

  const editProfile = (p: RoutingTeamProfile) => {
    const next = { ...p, phases: { ...p.phases } };
    setBaseline(JSON.stringify(next));
    setEditing(next);
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

  const updatePhase = (
    phase: string,
    field: keyof RoutingPhasePolicy,
    value: string | string[],
  ) => {
    if (!editing) return;
    const updated = { ...editing };
    updated.phases = { ...updated.phases };
    updated.phases[phase] = {
      ...(updated.phases[phase] || {
        agent: "",
        tier: "balanced",
        provider_priority: [],
        fallback: [],
      }),
      [field]: value,
    };
    setEditing(updated);
  };

  const addPhase = (phase: string) => {
    if (!editing) return;
    const updated = { ...editing };
    updated.phases = {
      ...updated.phases,
      [phase]: { agent: "", tier: "balanced", provider_priority: [], fallback: [] },
    };
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
    <section className="rounded-xl bg-kin-elevated/60 p-4 space-y-4">
      <div className="flex items-start justify-between gap-3">
        <div className="space-y-1 min-w-0">
          <h2 className="text-caption font-semibold uppercase tracking-label text-kin-muted">
            {tr("settings.routing.profiles")}
          </h2>
          <p className="text-body text-kin-secondary leading-prose">
            {tr("settings.routing.profilesDesc")}
          </p>
        </div>
        <Button variant="secondary" className="shrink-0" onClick={addProfile}>
          {tr("settings.routing.addProfile")}
        </Button>
      </div>

      {profiles.length === 0 && !editing ? (
        <p className="text-strong text-kin-muted">{tr("settings.routing.noTeams")}</p>
      ) : (
        <ul className="space-y-2">
          {profiles.map((p) => (
            <li
              key={p.id}
              className="rounded-lg border border-[var(--kin-hairline)] bg-[var(--kin-fill)] p-3 flex flex-col sm:flex-row sm:items-center gap-3"
            >
              <div className="min-w-0 flex-1 space-y-0.5">
                <div className="flex items-center gap-2 flex-wrap">
                  <span className="text-strong font-medium truncate">{p.name}</span>
                  {p.alias && (
                    <span className="text-micro font-mono text-kin-muted">{p.alias}</span>
                  )}
                  <span
                    className={`text-micro font-semibold uppercase tracking-label ${p.enabled ? "text-kin-green-ink" : "text-kin-muted"}`}
                  >
                    {p.enabled ? "enabled" : "disabled"}
                  </span>
                </div>
                <p className="text-caption text-kin-muted font-mono truncate">
                  {p.id} · {Object.keys(p.phases).length} phase(s) ·{" "}
                  {p.default_objective || "balanced"}
                </p>
              </div>
              <div className="flex flex-wrap gap-2 shrink-0">
                <Button variant="secondary" className="text-body" onClick={() => editProfile(p)}>
                  {tr("settings.provider.edit")}
                </Button>
                <Button
                  variant="secondary"
                  className="text-body text-kin-red-ink"
                  onClick={() => deleteProfile(p.id)}
                >
                  {tr("settings.provider.delete")}
                </Button>
              </div>
            </li>
          ))}
        </ul>
      )}

      {/* Editing form */}
      {editing && (
        <div className="rounded-lg border border-[var(--kin-hairline)] p-3 space-y-3 bg-kin-elevated">
          <h3 className="text-body font-semibold text-kin-secondary">
            {isNew ? "New profile" : "Edit profile"}
          </h3>
          <div className="space-y-1">
            <TextInput
              label={tr("settings.routing.profileId")}
              value={editing.id}
              onChange={(e) => setEditing({ ...editing, id: e.target.value })}
              className="font-mono text-body leading-4"
              disabled={!isNew}
              placeholder={isNew ? slugFromName(editing.name) || "auto-generated" : ""}
            />
            {/* The auto-generation note stays a `text-micro` sibling: the
                field's own hint would render it at caption size. */}
            {isNew && (
              <span className="text-micro text-kin-muted">
                ID will be auto-generated from the name if left empty
              </span>
            )}
          </div>
          <TextInput
            label={tr("settings.routing.profileName")}
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
          />
          <TextInput
            label={tr("settings.routing.alias")}
            value={editing.alias || ""}
            onChange={(e) => setEditing({ ...editing, alias: e.target.value })}
            className="font-mono text-body leading-4"
            placeholder="A"
            hint={tr("settings.routing.aliasHint")}
          />
          <label className="flex items-center gap-2 cursor-pointer">
            <input
              type="checkbox"
              checked={editing.enabled}
              onChange={(e) => setEditing({ ...editing, enabled: e.target.checked })}
            />
            <span className="text-body leading-4 text-kin-secondary">
              {tr("settings.routing.profileEnabled")}
            </span>
          </label>
          <div className="block space-y-1">
            <span className="text-body leading-4 font-medium text-kin-secondary">
              {tr("settings.routing.defaultObjective")}
            </span>
            <SearchSelect
              variant="field"
              label={tr("settings.routing.defaultObjective")}
              value={editing.default_objective || "balanced"}
              options={[
                { id: "balanced", label: tr("settings.routing.objectiveBalanced") },
                { id: "cost-min", label: tr("settings.routing.objectiveCostMin") },
                { id: "intelligent-max", label: tr("settings.routing.objectiveIntelligentMax") },
              ]}
              onChange={(next) => setEditing({ ...editing, default_objective: next })}
            />
          </div>

          {/* Phases */}
          <div className="space-y-2">
            <div className="flex items-center justify-between">
              <span className="text-body leading-4 font-medium text-kin-secondary">Phases</span>
              <div className="flex gap-1">
                {(["plan", "execute", "review", "chat"] as const).map((phase) => (
                  <button
                    key={phase}
                    type="button"
                    disabled={!!editing.phases[phase]}
                    onClick={() => addPhase(phase)}
                    className={`text-micro px-1.5 py-0.5 rounded border min-h-6 ${
                      editing.phases[phase]
                        ? "border-kin-green bg-kin-green/10 text-kin-green-ink cursor-default"
                        : "border-[var(--kin-hairline)] text-kin-muted hover:text-kin-blue-ink hover:border-kin-blue"
                    }`}
                  >
                    {phase}
                  </button>
                ))}
              </div>
            </div>
            {Object.entries(editing.phases).map(([phase, pp]) => (
              <div
                key={phase}
                className="rounded border border-[var(--kin-hairline)] p-2 space-y-2"
              >
                <div className="flex items-center justify-between">
                  <span className="text-caption font-mono font-semibold text-kin-secondary">
                    {phase}
                  </span>
                  <Button
                    variant="quiet-danger"
                    className="text-micro"
                    onClick={() => removePhase(phase)}
                  >
                    remove
                  </Button>
                </div>
                <div className="space-y-0.5">
                  <span className="text-micro text-kin-muted">{tr("settings.routing.agent")}</span>
                  <TextInput
                    isLabelHidden
                    label={tr("settings.routing.agent")}
                    value={pp.agent}
                    onChange={(e) => updatePhase(phase, "agent", e.target.value)}
                    className="min-h-9 text-body leading-4 font-mono"
                    placeholder="claude-code"
                  />
                </div>
                <div className="block space-y-0.5">
                  <span className="text-micro text-kin-muted">{tr("settings.routing.tier")}</span>
                  <SearchSelect
                    variant="field"
                    className="text-body"
                    label={tr("settings.routing.tier")}
                    value={pp.tier || "balanced"}
                    options={[
                      { id: "smart", label: "smart" },
                      { id: "balanced", label: "balanced" },
                      { id: "fast", label: "fast" },
                    ]}
                    onChange={(next) => updatePhase(phase, "tier", next)}
                  />
                </div>
                <div className="space-y-0.5">
                  <span className="text-micro text-kin-muted">
                    {tr("settings.routing.providerPriority")}
                  </span>
                  <TextInput
                    isLabelHidden
                    label={tr("settings.routing.providerPriority")}
                    value={pp.provider_priority.join(", ")}
                    onChange={(e) =>
                      updatePhase(
                        phase,
                        "provider_priority",
                        e.target.value
                          .split(",")
                          .map((s) => s.trim())
                          .filter(Boolean),
                      )
                    }
                    className="min-h-9 text-body leading-4 font-mono"
                    placeholder="provider-1, provider-2"
                  />
                </div>
                <div className="space-y-0.5">
                  <span className="text-micro text-kin-muted">
                    {tr("settings.routing.fallback")}
                  </span>
                  <TextInput
                    isLabelHidden
                    label={tr("settings.routing.fallback")}
                    value={pp.fallback.join(", ")}
                    onChange={(e) =>
                      updatePhase(
                        phase,
                        "fallback",
                        e.target.value
                          .split(",")
                          .map((s) => s.trim())
                          .filter(Boolean),
                      )
                    }
                    className="min-h-9 text-body leading-4 font-mono"
                    placeholder="next_provider_same_tier"
                  />
                </div>
              </div>
            ))}
          </div>

          <div className="flex flex-wrap gap-2">
            <Button
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
            >
              {busy ? tr("settings.saving") : tr("settings.routing.saveProfile")}
            </Button>
            <Button
              variant="secondary"
              onClick={() => {
                setEditing(null);
                setIsNew(false);
              }}
            >
              {tr("settings.provider.cancel")}
            </Button>
          </div>
        </div>
      )}

      <div className="flex items-center gap-3">
        {error && <span className="text-body leading-4 text-kin-red-ink">{error}</span>}
      </div>
    </section>
  );
}

// ---------------------------------------------------------------------------
// Team profile phase editor — helpers
// ---------------------------------------------------------------------------

// ValidRoutePhases is the list of known route phases.
export const ValidRoutePhases = ["plan", "execute", "review", "chat"] as const;
