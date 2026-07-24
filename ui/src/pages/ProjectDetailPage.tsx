import { useCallback, useEffect, useState } from "react";
import { Link, useNavigate, useParams } from "react-router-dom";
import {
  ApiError,
  getOnePager,
  getProject,
  getProjectPulse,
  getToken,
  listProjectArtifacts,
  patchProject,
  putOnePager,
  refreshProjectPulse,
  listRoutines,
  createRoutine,
  type Artifact,
  type Routine,
  type OnePagerSummary,
  type Project,
  type ProjectMode,
  type ProjectPulse,
} from "../api/client";
import { launchRecipe } from "../recipes/launch";
import ProjectSummaryCard from "../components/project/ProjectSummaryCard";
import { IconBack } from "../components/icons";
import Markdown from "../components/Markdown";
import Heatmap from "../components/project/Heatmap";
import { SkeletonLine, SlowConnectHint } from "../components/Skeleton";
import { useSlowHint } from "../hooks/useSlowHint";
import { useT } from "../i18n/react";
import { useAppStore } from "../store/appStore";

function formatWhen(ms: number): string {
  if (!ms) return "—";
  try {
    return new Date(ms).toLocaleString(undefined, {
      month: "short",
      day: "numeric",
      hour: "2-digit",
      minute: "2-digit",
    });
  } catch {
    return "—";
  }
}

/**
 * Project cover — pulse + editable One-Pager.
 * Scrolls inside AppShell main (overflow-y-auto).
 */
export default function ProjectDetailPage() {
  const { id = "" } = useParams();
  const navigate = useNavigate();
  const tr = useT();
  const pushToast = useAppStore((s) => s.pushToast);
  const reconnectGen = useAppStore((s) => s.reconnectGen);

  const [project, setProject] = useState<Project | null>(null);
  const [markdown, setMarkdown] = useState("");
  const [updatedAt, setUpdatedAt] = useState(0);
  const [artifacts, setArtifacts] = useState<Artifact[]>([]);
  const [pulse, setPulse] = useState<ProjectPulse | null>(null);
  const [refreshing, setRefreshing] = useState(false);
  const [windowDays, setWindowDays] = useState(90);
  const [error, setError] = useState<string | null>(null);
  const [loading, setLoading] = useState(true);
  const [editing, setEditing] = useState(false);
  const [draft, setDraft] = useState("");
  const [saving, setSaving] = useState(false);
  const [continuing, setContinuing] = useState(false);
  const [projectRoutines, setProjectRoutines] = useState<Routine[]>([]);
  const [showRoutineModal, setShowRoutineModal] = useState(false);
  const [routineTitle, setRoutineTitle] = useState("");
  const [routinePrompt, setRoutinePrompt] = useState("");
  const [routineInterval, setRoutineInterval] = useState(86400);
  const [creatingRoutine, setCreatingRoutine] = useState(false);

  const [summary, setSummary] = useState<OnePagerSummary | null>(null);
  const slow = useSlowHint(loading);

  const load = useCallback(async () => {
    if (!getToken() || !id) return;
    setLoading(true);
    try {
      const [p, op, arts, pu] = await Promise.all([
        getProject(id),
        getOnePager(id),
        listProjectArtifacts(id, 20).catch(() => [] as Artifact[]),
        getProjectPulse(id, windowDays).catch(() => null),
      ]);
      setProject(p);
      setMarkdown(op.markdown);
      setUpdatedAt(op.updated_at);
      setDraft(op.markdown);
      setArtifacts(arts);
      setPulse(pu);
      setSummary(op.one_pager_summary ?? null);

      try {
        const rs = (await listRoutines({ project_id: id, limit: 50 })) as Routine[];
        setProjectRoutines(Array.isArray(rs) ? rs : []);
      } catch {
        setProjectRoutines([]);
      }
      setError(null);
    } catch (e) {
      if (e instanceof ApiError && e.status === 401) return;
      if (e instanceof ApiError && e.status === 404) {
        setError(tr("projects.notFound"));
      } else {
        setError(e instanceof Error ? e.message : tr("projects.loadFailed"));
      }
      setProject(null);
    } finally {
      setLoading(false);
    }
  }, [id, tr, windowDays]);

  useEffect(() => {
    void load();
  }, [load, reconnectGen]);

  const onSave = async () => {
    if (!id) return;
    setSaving(true);
    try {
      const op = await putOnePager(id, draft, updatedAt || undefined);
      setMarkdown(op.markdown);
      setUpdatedAt(op.updated_at);
      setDraft(op.markdown);
      setEditing(false);
      pushToast(tr("projects.saved"));
    } catch (e) {
      if (e instanceof ApiError && e.status === 409) {
        pushToast(tr("projects.conflict"), "error");
        void load();
      } else {
        pushToast(
          e instanceof Error ? e.message : tr("projects.saveFailed"),
          "error",
        );
      }
    } finally {
      setSaving(false);
    }
  };

  const onRefreshPulse = async () => {
    if (!id) return;
    setRefreshing(true);
    try {
      const res = await refreshProjectPulse(id, {
        window_days: windowDays,
        write: true,
      });
      setPulse(res.pulse);
      setMarkdown(res.markdown);
      setDraft(res.markdown);
      setUpdatedAt(res.updated_at);
      pushToast(tr("projects.refreshed"));
    } catch (e) {
      pushToast(
        e instanceof Error ? e.message : tr("projects.refreshFailed"),
        "error",
      );
    } finally {
      setRefreshing(false);
    }
  };

  const recipeCtx = () => ({
    project_name: project?.name,
    project_id: id,
    cwd: project?.roots?.[0],
    mode: project?.mode,
  });

  const onLaunchRecipe = async (
    recipeId: "focus.continue" | "cover.update" | "project.memory.tidy",
  ) => {
    if (!project || !id) return;
    const cwd = (project.roots?.[0] || "").trim();
    if (!cwd) {
      pushToast(tr("projects.continueNeedRoot"), "error");
      return;
    }
    setContinuing(true);
    try {
      const t = await launchRecipe({
        id: recipeId,
        cwd,
        project_id: id,
        ctx: recipeCtx(),
      });
      navigate(`/tasks/${t.id}`);
    } catch (e) {
      pushToast(
        e instanceof Error ? e.message : tr("projects.recipeLaunchFailed"),
        "error",
      );
    } finally {
      setContinuing(false);
    }
  };


  const onModeChange = async (mode: ProjectMode) => {
    if (!id) return;
    try {
      const p = await patchProject(id, { mode });
      setProject(p);
    } catch (e) {
      pushToast(e instanceof Error ? e.message : "failed", "error");
    }
  };



  const onCreateRoutine = async () => {
    if (!project || !id) return;
    const cwd = project.roots?.[0];
    if (!cwd) {
      pushToast(tr("routines.actionFailed"), "error");
      return;
    }
    const prompt = routinePrompt.trim();
    if (!prompt) return;
    setCreatingRoutine(true);
    try {
      const r = await createRoutine({
        title: routineTitle.trim() || undefined,
        project_id: id,
        cwd,
        prompt,
        interval_secs: routineInterval,
        agent: "kin",
      });
      setProjectRoutines((list) => [r, ...list]);
      setShowRoutineModal(false);
      setRoutineTitle("");
      setRoutinePrompt("");
      pushToast(tr("routines.created"), "info");
    } catch (e) {
      pushToast(e instanceof Error ? e.message : tr("routines.actionFailed"), "error");
    } finally {
      setCreatingRoutine(false);
    }
  };

  if (loading) {
    return (
      <div className="flex-1 min-h-0 overflow-y-auto kin-scroll">
        <div className="mx-auto max-w-4xl px-4 py-6 space-y-3">
          {slow && <SlowConnectHint show />}
          <SkeletonLine />
          <SkeletonLine />
          <SkeletonLine />
        </div>
      </div>
    );
  }

  if (error || !project) {
    return (
      <div className="flex-1 min-h-0 overflow-y-auto kin-scroll">
        <div className="mx-auto max-w-4xl px-4 py-6">
          <button
            type="button"
            className="mb-4 inline-flex items-center gap-1 text-[13px] text-kin-secondary hover:text-kin-text"
            onClick={() => {
              if (window.history.length > 1) navigate(-1);
              else navigate("/new");
            }}
          >
            <IconBack size={14} />
            {tr("projects.back")}
          </button>
          <div className="rounded-lg border border-red-500/30 bg-red-500/10 px-3 py-2 text-[13px] text-red-300">
            {error || tr("projects.notFound")}
          </div>
        </div>
      </div>
    );
  }

  return (
    <>
    <div className="flex-1 min-h-0 overflow-y-auto kin-scroll">
      <div className="mx-auto max-w-4xl px-4 py-6 pb-16">
        <button
          type="button"
          className="mb-3 inline-flex items-center gap-1 text-[13px] text-kin-secondary hover:text-kin-text"
          onClick={() => {
            if (window.history.length > 1) navigate(-1);
            else navigate("/new");
          }}
        >
          <IconBack size={14} />
          {tr("projects.back")}
        </button>

        <div className="mb-4 flex flex-wrap items-start justify-between gap-3">
          <div>
            <h1 className="text-lg font-semibold text-kin-text">{project.name}</h1>
            {project.roots?.[0] && (
              <div className="mt-1 text-[12px] text-kin-secondary truncate max-w-[min(100%,420px)]">
                {project.roots[0]}
              </div>
            )}
          </div>
          <div className="flex flex-wrap items-center gap-2">
            <select
              className="rounded-lg border border-kin-border bg-transparent px-2 py-1.5 text-[12.5px] text-kin-text"
              value={project.mode}
              onChange={(e) => void onModeChange(e.target.value as ProjectMode)}
            >
              <option value="ship">{tr("projects.modeShip")}</option>
              <option value="learn">{tr("projects.modeLearn")}</option>
              <option value="explore">{tr("projects.modeExplore")}</option>
              <option value="maintain">{tr("projects.modeMaintain")}</option>
            </select>
            <button
              type="button"
              disabled={continuing}
              className="rounded-lg border border-kin-border px-3 py-1.5 text-[13px] text-kin-text hover:bg-[var(--kin-fill-strong)] disabled:opacity-50"
              onClick={() => void onLaunchRecipe("cover.update")}
              title={tr("projects.summarizeHint")}
            >
              {continuing ? tr("projects.recipeLaunching") : tr("projects.summarize")}
            </button>
            <button
              type="button"
              disabled={continuing}
              className="rounded-lg bg-kin-accent px-3 py-1.5 text-[13px] font-medium text-white disabled:opacity-50"
              onClick={() => void onLaunchRecipe("focus.continue")}
              title={tr("projects.continueHint")}
            >
              {continuing ? tr("projects.recipeLaunching") : tr("projects.continueFocus")}
            </button>
            <button
              type="button"
              disabled={continuing}
              className="rounded-lg border border-kin-border px-3 py-1.5 text-[13px] text-kin-text hover:bg-[var(--kin-fill-strong)] disabled:opacity-50"
              onClick={() => void onLaunchRecipe("project.memory.tidy")}
              title={tr("projects.memoryTidyHint")}
            >
              {continuing ? tr("projects.recipeLaunching") : tr("projects.memoryTidy")}
            </button>
            <button
              type="button"
              className="rounded-lg border border-kin-border px-3 py-1.5 text-[13px] text-kin-text hover:bg-[var(--kin-fill-strong)]"
              onClick={() => setShowRoutineModal(true)}
            >
              {tr("routines.create")}
            </button>
            {projectRoutines.length > 0 && (
              <span className="text-[12px] text-kin-muted">
                {tr("routines.projectCount", { count: projectRoutines.length })}
              </span>
            )}
            {!editing ? (
              <button
                type="button"
                className="rounded-lg border border-kin-border px-3 py-1.5 text-[13px] text-kin-text hover:bg-[var(--kin-fill-strong)]"
                onClick={() => {
                  setDraft(markdown);
                  setEditing(true);
                }}
              >
                {tr("projects.editOnePager")}
              </button>
            ) : (
              <>
                <button
                  type="button"
                  disabled={saving}
                  className="rounded-lg bg-kin-accent px-3 py-1.5 text-[13px] font-medium text-white disabled:opacity-50"
                  onClick={() => void onSave()}
                >
                  {tr("projects.saveOnePager")}
                </button>
                <button
                  type="button"
                  className="rounded-lg px-3 py-1.5 text-[13px] text-kin-secondary"
                  onClick={() => {
                    setDraft(markdown);
                    setEditing(false);
                  }}
                >
                  {tr("projects.cancelEdit")}
                </button>
              </>
            )}
          </div>
        </div>

        <section className="mb-4">
          <ProjectSummaryCard project={project} summary={summary} />
        </section>

        <section className="mb-4 rounded-xl border border-kin-border bg-kin-panel p-4 space-y-3">
          <div className="flex flex-wrap items-center justify-between gap-2">
            <div className="text-[12px] font-medium uppercase tracking-wide text-kin-secondary">
              {tr("projects.pulse")}
            </div>
            <div className="flex flex-wrap items-center gap-2">
              <select
                className="rounded-lg border border-kin-border bg-transparent px-2 py-1 text-[12px] text-kin-text"
                value={windowDays}
                onChange={(e) => setWindowDays(Number(e.target.value) || 90)}
              >
                <option value={30}>{tr("projects.window30")}</option>
                <option value={90}>{tr("projects.window90")}</option>
                <option value={180}>{tr("projects.window180")}</option>
              </select>
              <button
                type="button"
                disabled={refreshing}
                className="rounded-lg border border-kin-border px-2.5 py-1 text-[12.5px] text-kin-text hover:bg-[var(--kin-fill-strong)] disabled:opacity-50"
                onClick={() => void onRefreshPulse()}
              >
                {refreshing ? tr("projects.refreshing") : tr("projects.refreshPulse")}
              </button>
            </div>
          </div>
          {pulse ? (
            <>
              <div className="flex flex-wrap gap-3 text-[12px] text-kin-secondary">
                <span>
                  {tr("projects.sessionsInWindow")}:{" "}
                  <strong className="text-kin-text tabular-nums">
                    {pulse.session_window}
                  </strong>
                </span>
                <span>
                  {tr("projects.commitsInWindow")}:{" "}
                  <strong className="text-kin-text tabular-nums">
                    {pulse.git_available ? pulse.commit_window : "—"}
                  </strong>
                </span>
                {(pulse.sessions_running > 0 || pulse.sessions_waiting > 0) && (
                  <span>
                    {pulse.sessions_running > 0 && <>run {pulse.sessions_running} </>}
                    {pulse.sessions_waiting > 0 && <>wait {pulse.sessions_waiting}</>}
                  </span>
                )}
              </div>
              <div className="grid gap-4 sm:grid-cols-2">
                <Heatmap days={pulse.session_heat} title={tr("projects.sessionHeat")} />
                <Heatmap days={pulse.commit_heat} title={tr("projects.commitHeat")} />
              </div>
              {pulse.top_paths && pulse.top_paths.length > 0 && (
                <div className="text-[12px] text-kin-secondary">
                  <span className="text-kin-muted">{tr("projects.hotModules")}: </span>
                  {pulse.top_paths
                    .slice(0, 6)
                    .map((x: { path: string; count: number }) => `${x.path}(${x.count})`)
                    .join(" · ")}
                </div>
              )}
            </>
          ) : (
            <div className="text-[12.5px] text-kin-secondary">
              {tr("projects.pulseEmpty")}
            </div>
          )}
        </section>

        <div className="grid gap-4 lg:grid-cols-[1fr_240px]">
          <section className="rounded-xl border border-kin-border bg-kin-panel p-4 min-h-[320px]">
            <div className="mb-2 text-[12px] font-medium uppercase tracking-wide text-kin-secondary">
              {tr("projects.onePager")}
            </div>
            {editing ? (
              <textarea
                className="min-h-[480px] w-full resize-y rounded-lg border border-kin-border bg-transparent p-3 font-mono text-[12.5px] leading-relaxed text-kin-text"
                value={draft}
                onChange={(e) => setDraft(e.target.value)}
              />
            ) : (
              <div className="prose-kin text-[13.5px] leading-relaxed">
                <Markdown text={markdown} />
              </div>
            )}
          </section>

          <aside className="space-y-3">
            <section className="rounded-xl border border-kin-border bg-kin-panel p-3">
              <div className="mb-2 text-[12px] font-medium uppercase tracking-wide text-kin-secondary">
                {tr("projects.relatedArtifacts")}
              </div>
              {artifacts.length === 0 ? (
                <div className="text-[12.5px] text-kin-secondary">
                  {tr("projects.noArtifacts")}
                </div>
              ) : (
                <ul className="space-y-1.5">
                  {artifacts.map((a) => (
                    <li key={a.id}>
                      <Link
                        to={`/artifacts/${a.id}`}
                        className="block rounded-lg px-2 py-1.5 hover:bg-[var(--kin-fill-strong)]"
                      >
                        <div className="truncate text-[12.5px] text-kin-text">
                          {a.title}
                        </div>
                        <div className="mt-0.5 text-[11px] text-kin-secondary">
                          {a.kind} · {formatWhen(a.created_at)}
                        </div>
                      </Link>
                    </li>
                  ))}
                </ul>
              )}
            </section>
          </aside>
        </div>
      </div>
    </div>

      {showRoutineModal && (
        <div className="fixed inset-0 z-50 flex items-center justify-center bg-black/60 p-4">
          <div className="w-full max-w-md rounded-2xl border border-kin-hairline-strong bg-kin-elevated p-5 shadow-window">
            <h2 className="text-[16px] font-semibold text-kin-text">{tr("routines.createTitle")}</h2>
            <label className="mt-4 block text-[12px] text-kin-secondary">
              {tr("routines.titleLabel")}
              <input
                value={routineTitle}
                onChange={(e) => setRoutineTitle(e.target.value)}
                placeholder={tr("routines.titlePlaceholder")}
                className="mt-1 w-full rounded-lg border border-[var(--kin-hairline)] bg-[var(--kin-fill)] px-3 py-2 text-[13px] text-kin-text outline-none focus:border-kin-blue/40"
              />
            </label>
            <label className="mt-3 block text-[12px] text-kin-secondary">
              {tr("routines.promptLabel")}
              <textarea
                value={routinePrompt}
                onChange={(e) => setRoutinePrompt(e.target.value)}
                placeholder={tr("routines.promptPlaceholder")}
                rows={4}
                className="mt-1 w-full resize-y rounded-lg border border-[var(--kin-hairline)] bg-[var(--kin-fill)] px-3 py-2 text-[13px] text-kin-text outline-none focus:border-kin-blue/40"
              />
            </label>
            <label className="mt-3 block text-[12px] text-kin-secondary">
              {tr("routines.intervalLabel")}
              <select
                value={routineInterval}
                onChange={(e) => setRoutineInterval(Number(e.target.value))}
                className="mt-1 w-full rounded-lg border border-[var(--kin-hairline)] bg-[var(--kin-fill)] px-3 py-2 text-[13px] text-kin-text outline-none"
              >
                <option value={3600}>{tr("routines.interval1h")}</option>
                <option value={21600}>{tr("routines.interval6h")}</option>
                <option value={86400}>{tr("routines.interval1d")}</option>
                <option value={604800}>{tr("routines.interval1w")}</option>
              </select>
            </label>
            <div className="mt-5 flex justify-end gap-2">
              <button
                type="button"
                className="rounded-lg px-3 py-1.5 text-[13px] text-kin-secondary"
                onClick={() => setShowRoutineModal(false)}
              >
                {tr("routines.cancel")}
              </button>
              <button
                type="button"
                disabled={creatingRoutine || !routinePrompt.trim()}
                className="rounded-lg bg-kin-accent px-3 py-1.5 text-[13px] font-medium text-white disabled:opacity-50"
                onClick={() => void onCreateRoutine()}
              >
                {tr("routines.submitCreate")}
              </button>
            </div>
          </div>
        </div>
      )}
    </>
  );
}
