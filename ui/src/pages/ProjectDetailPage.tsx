import { useCallback, useEffect, useRef, useState, type KeyboardEvent } from "react";
import { Link, useNavigate, useParams, useSearchParams } from "react-router-dom";
import {
  ApiError,
  getOnePager,
  getProject,
  getProjectPulse,
  isAuthenticated,
  listAgentSessions,
  listProjectArtifacts,
  listProjectTasks,
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
import { IconBack, IconMachine } from "../components/icons";
import RoutineScheduleFields, {
  defaultNextRunLocal,
  parseLocalDateTime,
} from "../components/routine/RoutineScheduleFields";
import { serializeRoutineRule, type RoutineRule } from "../lib/routineRecurrence";
import Markdown from "../components/Markdown";
import Heatmap from "../components/project/Heatmap";
import { SkeletonLine, SlowConnectHint } from "../components/Skeleton";
import { useSlowHint } from "../hooks/useSlowHint";
import { useMachines } from "../hooks/useMachines";
import { agentAvatarMeta, agentDisplayName } from "../lib/agentMention";
import {
  loadProjectChats,
  normalizeProjectTab,
  projectRoots,
  PROJECT_TABS,
  type ProjectChatRow,
  type ProjectChatsOutcome,
  type ProjectTab,
} from "../lib/projectChats";
import { formatRelativeTime } from "../lib/relativeTime";
import { taskCardStatusView } from "../lib/taskCardStatus";
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
  const [routineRule, setRoutineRule] = useState<RoutineRule | null>(null);
  const [routineNextLocal, setRoutineNextLocal] = useState(() => defaultNextRunLocal());
  const [creatingRoutine, setCreatingRoutine] = useState(false);

  const [summary, setSummary] = useState<OnePagerSummary | null>(null);
  const slow = useSlowHint(loading);

  // The tab lives in the URL for the same reason the session filters do: the
  // header and the list cannot disagree, a reload keeps the tab, and a project's
  // chats can be linked. An unknown value is the overview (see
  // `normalizeProjectTab`), never an empty screen.
  const [params, setParams] = useSearchParams();
  const tab = normalizeProjectTab(params.get("tab"));
  const selectTab = (next: ProjectTab) => {
    const p = new URLSearchParams(params);
    if (next === "overview") p.delete("tab");
    else p.set("tab", next);
    // Replace, not push: the tab is a view of this project, and Back should
    // leave the project rather than walk through the views it passed through.
    setParams(p, { replace: true });
  };

  const openChat = (row: ProjectChatRow) => {
    if (row.task) navigate(`/tasks/${encodeURIComponent(row.task.id)}`);
    else if (row.session) navigate(`/agent-sessions/${encodeURIComponent(row.session.id)}`);
  };

  const [chatRows, setChatRows] = useState<ProjectChatRow[]>([]);
  // Rows answer for exactly one project. The page component outlives a route
  // change, so without this the new project would wear the old project's list
  // for the moment between its own read starting and finishing.
  const [chatsFor, setChatsFor] = useState<string | null>(null);
  const [chatsLoading, setChatsLoading] = useState(false);
  const [chatsError, setChatsError] = useState<string | null>(null);
  const [chatsPartial, setChatsPartial] = useState(false);
  const chatsRequest = useRef(0);
  const { machines } = useMachines();
  const selfDeviceId = (machines.find((machine) => machine.isSelf)?.id ?? "").trim();

  const load = useCallback(async () => {
    if (!isAuthenticated() || !id) return;
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
        const rs = await listRoutines({ project_id: id, limit: 50 });
        setProjectRoutines(rs.routines ?? []);
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

  /**
   * The project's conversations, read when the tab is first shown.
   *
   * Two sources, one list: `GET /projects/{id}/tasks` is the project's Kin
   * tasks (`project_id`, plus same-cwd rows), and the imported agent sessions
   * whose cwd is one of the project's roots — the same two feeds the phone's
   * session list merges, narrowed to this project. The task read is the one
   * that can fail the whole tab; a root whose session read fails leaves the
   * tasks on screen and says so underneath, because a half list that pretends
   * to be whole is the failure this note exists to prevent.
   *
   * The previous answer stays visible while a reload runs: switching tabs back
   * and forth should not blank a list that is already known.
   */
  const loadChats = useCallback(async () => {
    if (!project) return;
    const projectId = project.id;
    const gen = ++chatsRequest.current;
    setChatsLoading(true);
    setChatsError(null);
    setChatsPartial(false);
    let outcome: ProjectChatsOutcome | null = null;
    try {
      outcome = await loadProjectChats({
        projectId,
        roots: projectRoots(project),
        feed: {
          tasks: () => listProjectTasks(projectId, 50),
          sessions: (root) => listAgentSessions({ cwd: root, limit: 50 }),
        },
        copy: { untitled: tr("sessions.untitled"), loadFailed: tr("projects.loadFailed") },
        selfDeviceId,
        isCurrent: () => gen === chatsRequest.current,
      });
    } catch {
      // The loader reports feed failures as values; anything that still throws
      // is a shape the console did not expect. Show the retry box rather than
      // leave the tab spinning on a rejected promise nobody awaits.
      if (gen === chatsRequest.current) {
        setChatRows([]);
        setChatsFor(projectId);
        setChatsPartial(false);
        setChatsError(tr("projects.loadFailed"));
      }
    } finally {
      // The loading flag always belongs to the newest read: a superseded one
      // leaves it to the read that replaced it.
      if (gen === chatsRequest.current) setChatsLoading(false);
    }
    // A superseded read writes nothing; the read that replaced it owns the
    // state, including the loading flag.
    if (!outcome) return;
    setChatRows(outcome.rows);
    setChatsFor(outcome.projectId);
    setChatsPartial(outcome.partial);
    setChatsError(outcome.error);
  }, [project, tr, selfDeviceId]);

  useEffect(() => {
    if (tab !== "chats" || !project) return;
    void loadChats();
  }, [tab, project, loadChats]);

  // Only the chats tab is worth a parameter; `?tab=overview`, an old value or a
  // typo all mean the bare project URL. Removing it keeps a copied link honest
  // and stops the address bar disagreeing with the screen.
  useEffect(() => {
    const raw = params.get("tab");
    if (raw === null || raw === "chats") return;
    const next = new URLSearchParams(params);
    next.delete("tab");
    setParams(next, { replace: true });
  }, [params, setParams]);

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
        pushToast(e instanceof Error ? e.message : tr("projects.saveFailed"), "error");
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
      pushToast(e instanceof Error ? e.message : tr("projects.refreshFailed"), "error");
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
      pushToast(e instanceof Error ? e.message : tr("projects.recipeLaunchFailed"), "error");
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
      const nextMs = parseLocalDateTime(routineNextLocal);
      const recurrence = serializeRoutineRule(routineRule, nextMs);
      const r = await createRoutine({
        title: routineTitle.trim() || undefined,
        project_id: id,
        cwd,
        prompt,
        ...(recurrence
          ? { recurrence }
          : {
              interval_secs: routineInterval,
              ...(nextMs != null ? { next_due_at: nextMs } : {}),
            }),
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
            className="mb-4 inline-flex items-center gap-1 text-strong text-kin-secondary hover:text-kin-text"
            onClick={() => {
              // `history.length` counts entries from other sites too, so on a
              // cold launch it says "there is somewhere to go back to" and
              // leaves the app. The router's own index is 0 when this document
              // has no in-app entry behind it.
              if ((window.history.state?.idx ?? 0) > 0) navigate(-1);
              else navigate("/projects");
            }}
          >
            <IconBack size={14} />
            {tr("projects.back")}
          </button>
          <div className="rounded-lg border border-kin-red/30 bg-kin-red/10 px-3 py-2 text-strong text-kin-red-ink">
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
            className="mb-3 inline-flex items-center gap-1 text-strong text-kin-secondary hover:text-kin-text"
            onClick={() => {
              if ((window.history.state?.idx ?? 0) > 0) navigate(-1);
              else navigate("/projects");
            }}
          >
            <IconBack size={14} />
            {tr("projects.back")}
          </button>

          <div className="mb-4 flex flex-wrap items-start justify-between gap-3">
            <div>
              <h1 className="text-title leading-7 font-semibold text-kin-text">{project.name}</h1>
              {project.roots?.[0] && (
                <div className="mt-1 text-body text-kin-secondary truncate max-w-sheet">
                  {project.roots[0]}
                </div>
              )}
            </div>
            <div className="flex flex-wrap items-center gap-2">
              <select
                className="rounded-lg border border-kin-hairline bg-transparent px-2 py-1.5 text-body text-kin-text"
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
                className="rounded-lg border border-kin-hairline px-3 py-1.5 text-strong text-kin-text hover:bg-[var(--kin-fill-strong)] disabled:opacity-50"
                onClick={() => void onLaunchRecipe("cover.update")}
                title={tr("projects.summarizeHint")}
              >
                {continuing ? tr("projects.recipeLaunching") : tr("projects.summarize")}
              </button>
              <button
                type="button"
                disabled={continuing}
                className="rounded-lg bg-kin-blue px-3 py-1.5 text-strong font-medium text-kin-on-brand disabled:opacity-50"
                onClick={() => void onLaunchRecipe("focus.continue")}
                title={tr("projects.continueHint")}
              >
                {continuing ? tr("projects.recipeLaunching") : tr("projects.continueFocus")}
              </button>
              <button
                type="button"
                disabled={continuing}
                className="rounded-lg border border-kin-hairline px-3 py-1.5 text-strong text-kin-text hover:bg-[var(--kin-fill-strong)] disabled:opacity-50"
                onClick={() => void onLaunchRecipe("project.memory.tidy")}
                title={tr("projects.memoryTidyHint")}
              >
                {continuing ? tr("projects.recipeLaunching") : tr("projects.memoryTidy")}
              </button>
              <button
                type="button"
                className="rounded-lg border border-kin-hairline px-3 py-1.5 text-strong text-kin-text hover:bg-[var(--kin-fill-strong)]"
                onClick={() => setShowRoutineModal(true)}
              >
                {tr("routines.create")}
              </button>
              {projectRoutines.length > 0 && (
                <span className="text-body text-kin-muted">
                  {tr("routines.projectCount", { count: projectRoutines.length })}
                </span>
              )}
              {tab === "overview" &&
                (!editing ? (
                  <button
                    type="button"
                    className="rounded-lg border border-kin-hairline px-3 py-1.5 text-strong text-kin-text hover:bg-[var(--kin-fill-strong)]"
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
                      className="rounded-lg bg-kin-blue px-3 py-1.5 text-strong font-medium text-kin-on-brand disabled:opacity-50"
                      onClick={() => void onSave()}
                    >
                      {tr("projects.saveOnePager")}
                    </button>
                    <button
                      type="button"
                      className="rounded-lg px-3 py-1.5 text-strong text-kin-secondary"
                      onClick={() => {
                        setDraft(markdown);
                        setEditing(false);
                      }}
                    >
                      {tr("projects.cancelEdit")}
                    </button>
                  </>
                ))}
            </div>
          </div>

          <ProjectTabStrip tab={tab} onSelect={selectTab} />

          {tab === "overview" && (
            <div role="tabpanel" id="project-panel-overview" aria-labelledby="project-tab-overview">
              <section className="mb-4">
                <ProjectSummaryCard project={project} summary={summary} />
              </section>

              <section className="mb-4 rounded-xl bg-kin-panel p-4 space-y-3">
                <div className="flex flex-wrap items-center justify-between gap-2">
                  <div className="text-body font-medium uppercase tracking-label text-kin-secondary">
                    {tr("projects.pulse")}
                  </div>
                  <div className="flex flex-wrap items-center gap-2">
                    <select
                      className="rounded-lg border border-kin-hairline bg-transparent px-2 py-1 text-body text-kin-text"
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
                      className="rounded-lg border border-kin-hairline px-2.5 py-1 text-body text-kin-text hover:bg-[var(--kin-fill-strong)] disabled:opacity-50"
                      onClick={() => void onRefreshPulse()}
                    >
                      {refreshing ? tr("projects.refreshing") : tr("projects.refreshPulse")}
                    </button>
                  </div>
                </div>
                {pulse ? (
                  <>
                    <div className="flex flex-wrap gap-3 text-body text-kin-secondary">
                      <span>
                        {tr("projects.sessionsInWindow")}
                        {tr("common.labelSeparator")}
                        <strong className="text-kin-text tabular-nums">
                          {pulse.session_window}
                        </strong>
                      </span>
                      <span>
                        {tr("projects.commitsInWindow")}
                        {tr("common.labelSeparator")}
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
                      <div className="text-body text-kin-secondary">
                        <span className="text-kin-muted">
                          {tr("projects.hotModules")}
                          {tr("common.labelSeparator")}
                        </span>
                        {pulse.top_paths
                          .slice(0, 6)
                          .map((x: { path: string; count: number }) => `${x.path}(${x.count})`)
                          .join(" · ")}
                      </div>
                    )}
                  </>
                ) : (
                  <div className="text-body text-kin-secondary">{tr("projects.pulseEmpty")}</div>
                )}
              </section>

              <div className="grid gap-4 lg:grid-cols-[1fr_240px]">
                <section className="rounded-xl bg-kin-panel p-4 min-h-80">
                  <div className="mb-2 text-body font-medium uppercase tracking-label text-kin-secondary">
                    {tr("projects.onePager")}
                  </div>
                  {editing ? (
                    <textarea
                      className="min-h-[480px] w-full resize-y rounded-lg border border-kin-hairline bg-transparent p-3 font-mono text-body leading-prose text-kin-text"
                      value={draft}
                      onChange={(e) => setDraft(e.target.value)}
                    />
                  ) : (
                    <div className="prose-kin text-strong leading-prose">
                      <Markdown text={markdown} />
                    </div>
                  )}
                </section>

                <aside className="space-y-3">
                  <section className="rounded-xl bg-kin-panel p-3">
                    <div className="mb-2 text-body font-medium uppercase tracking-label text-kin-secondary">
                      {tr("projects.relatedArtifacts")}
                    </div>
                    {artifacts.length === 0 ? (
                      <div className="text-body text-kin-secondary">
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
                              <div className="truncate text-body text-kin-text">{a.title}</div>
                              <div className="mt-0.5 text-caption text-kin-secondary">
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
          )}

          {tab === "chats" && (
            <div role="tabpanel" id="project-panel-chats" aria-labelledby="project-tab-chats">
              <ProjectChatsPanel
                // Rows read for another project are not this project's answer:
                // showing them under the new name is worse than a skeleton.
                rows={chatsFor === project.id ? chatRows : []}
                loading={chatsLoading || chatsFor !== project.id}
                error={chatsError}
                partial={chatsPartial}
                root={projectRoots(project)[0] ?? ""}
                onRetry={() => void loadChats()}
                onOpen={openChat}
              />
            </div>
          )}
        </div>
      </div>

      {showRoutineModal && (
        <div className="fixed inset-0 z-50 flex items-center justify-center bg-black/60 p-4">
          <div className="w-full max-w-md rounded-2xl bg-kin-elevated p-5 shadow-e3">
            <h2 className="text-subtitle font-semibold text-kin-text">
              {tr("routines.createTitle")}
            </h2>
            <label className="mt-4 block text-body text-kin-secondary">
              {tr("routines.titleLabel")}
              <input
                value={routineTitle}
                onChange={(e) => setRoutineTitle(e.target.value)}
                placeholder={tr("routines.titlePlaceholder")}
                className="mt-1 w-full rounded-lg border border-[var(--kin-hairline)] bg-[var(--kin-fill)] px-3 py-2 text-strong text-kin-text outline-none focus:border-kin-blue/40"
              />
            </label>
            <label className="mt-3 block text-body text-kin-secondary">
              {tr("routines.promptLabel")}
              <textarea
                value={routinePrompt}
                onChange={(e) => setRoutinePrompt(e.target.value)}
                placeholder={tr("routines.promptPlaceholder")}
                rows={4}
                className="mt-1 w-full resize-y rounded-lg border border-[var(--kin-hairline)] bg-[var(--kin-fill)] px-3 py-2 text-strong text-kin-text outline-none focus:border-kin-blue/40"
              />
            </label>
            <div className="mt-3 rounded-xl border border-[var(--kin-hairline)] bg-[var(--kin-fill)] px-3 py-2.5">
              <RoutineScheduleFields
                intervalSecs={routineInterval}
                onIntervalChange={setRoutineInterval}
                nextRunLocal={routineNextLocal}
                onNextRunLocalChange={setRoutineNextLocal}
                rule={routineRule}
                onRuleChange={setRoutineRule}
                disabled={creatingRoutine}
              />
            </div>
            <div className="mt-5 flex justify-end gap-2">
              <button
                type="button"
                className="rounded-lg px-3 py-1.5 text-strong text-kin-secondary"
                onClick={() => setShowRoutineModal(false)}
              >
                {tr("routines.cancel")}
              </button>
              <button
                type="button"
                disabled={creatingRoutine || !routinePrompt.trim()}
                className="rounded-lg bg-kin-blue px-3 py-1.5 text-strong font-medium text-kin-on-brand disabled:opacity-50"
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

function ProjectTabStrip({
  tab,
  onSelect,
}: {
  tab: ProjectTab;
  onSelect: (tab: ProjectTab) => void;
}) {
  const tr = useT();
  const refs = useRef<Record<string, HTMLButtonElement | null>>({});
  const labels: Record<ProjectTab, string> = {
    overview: tr("projects.tabOverview"),
    chats: tr("projects.tabChats"),
  };

  // A tab strip is one stop in the tab order and the arrow keys move within it
  // (`aria-selected` on a `role="tab"` with a roving `tabIndex`). Without this
  // the two buttons would be two stops whose selection only changes on Enter,
  // which reads as a pair of links, not a tab strip.
  const onKeyDown = (event: KeyboardEvent<HTMLDivElement>) => {
    if (
      event.key !== "ArrowRight" &&
      event.key !== "ArrowLeft" &&
      event.key !== "Home" &&
      event.key !== "End"
    ) {
      return;
    }
    const index = PROJECT_TABS.indexOf(tab);
    const next =
      event.key === "Home"
        ? 0
        : event.key === "End"
          ? PROJECT_TABS.length - 1
          : event.key === "ArrowRight"
            ? (index + 1) % PROJECT_TABS.length
            : (index - 1 + PROJECT_TABS.length) % PROJECT_TABS.length;
    event.preventDefault();
    const id = PROJECT_TABS[next];
    onSelect(id);
    refs.current[id]?.focus();
  };

  return (
    <div
      role="tablist"
      aria-label={tr("projects.tabs")}
      onKeyDown={onKeyDown}
      className="mb-4 flex gap-1 rounded-xl bg-kin-elevated/50 p-1"
    >
      {PROJECT_TABS.map((id) => {
        const selected = id === tab;
        return (
          <button
            key={id}
            ref={(node) => {
              refs.current[id] = node;
            }}
            type="button"
            role="tab"
            id={`project-tab-${id}`}
            aria-selected={selected}
            tabIndex={selected ? 0 : -1}
            onClick={() => onSelect(id)}
            className={[
              "min-h-11 flex-1 rounded-lg px-3 text-strong font-medium outline-none transition sm:flex-none",
              "focus-visible:ring-2 focus-visible:ring-kin-focus-ring",
              selected
                ? "bg-kin-blue text-kin-on-brand"
                : "text-kin-secondary hover:bg-[var(--kin-fill)] hover:text-kin-text",
            ].join(" ")}
          >
            {labels[id]}
          </button>
        );
      })}
    </div>
  );
}

function ProjectChatsPanel({
  rows,
  loading,
  error,
  partial,
  root,
  onRetry,
  onOpen,
}: {
  rows: ProjectChatRow[];
  loading: boolean;
  error: string | null;
  partial: boolean;
  /** The root a new chat would open in; empty when the project has none. */
  root: string;
  onRetry: () => void;
  onOpen: (row: ProjectChatRow) => void;
}) {
  const tr = useT();
  const now = Date.now();

  return (
    <section className="rounded-xl bg-kin-panel p-4">
      <div className="mb-2 flex flex-wrap items-center justify-between gap-2">
        <div className="text-body font-medium uppercase tracking-label text-kin-secondary">
          {tr("projects.recentSessions")}
        </div>
        {root && (
          <Link
            to={`/new?cwd=${encodeURIComponent(root)}`}
            className="rounded-lg bg-kin-blue px-3 py-1.5 text-strong font-medium text-kin-on-brand"
          >
            {tr("projects.newChat")}
          </Link>
        )}
      </div>

      {error ? (
        <div
          role="alert"
          className="rounded-lg border border-kin-red/30 bg-kin-red/10 px-3 py-2 text-strong text-kin-red-ink"
        >
          <p>{error}</p>
          <button
            type="button"
            onClick={onRetry}
            className="mt-2 min-h-11 rounded-lg border border-kin-red/40 px-3 text-strong text-kin-red-ink"
          >
            {tr("projects.chatsRetry")}
          </button>
        </div>
      ) : loading && rows.length === 0 ? (
        <div className="space-y-3 py-2">
          <SkeletonLine />
          <SkeletonLine />
          <SkeletonLine />
        </div>
      ) : rows.length === 0 ? (
        <div className="py-2 text-body text-kin-secondary">
          <p>{tr("projects.noSessions")}</p>
          <p className="mt-1 text-kin-muted">{tr("projects.chatsEmptyHint")}</p>
        </div>
      ) : (
        <ul className="divide-y divide-[var(--kin-hairline)]">
          {rows.map((row) => {
            const avatar = agentAvatarMeta(row.agentId);
            const status = row.task ? taskCardStatusView(row.task.status) : null;
            // Only the states a reader can act on get a dot: every finished
            // chat is green in the list only because it is unread, and this
            // screen has no unread notion — a field of dots would say nothing.
            const attention =
              status &&
              (status.tone === "running" || status.tone === "approval" || status.tone === "failed")
                ? status.dotClass
                : null;
            const label = [
              row.title,
              agentDisplayName(row.agentId),
              formatRelativeTime(row.at, now),
              status ? tr(status.labelKey) : "",
              row.remote ? tr("machine.remote") : "",
            ]
              .filter(Boolean)
              .join(" · ");
            return (
              <li key={row.task ? `task-${row.key}` : `session-${row.key}`}>
                <button
                  type="button"
                  onClick={() => onOpen(row)}
                  aria-label={label}
                  className="kin-row-press flex min-h-11 w-full items-center gap-2.5 px-1 py-2.5 text-left"
                >
                  <span className="flex w-2 flex-none justify-center">
                    {attention ? (
                      <span className={`h-1.5 w-1.5 rounded-full ${attention}`} aria-hidden />
                    ) : null}
                  </span>
                  <span
                    className={`flex h-5 w-5 flex-none items-center justify-center rounded-full text-micro font-semibold ${avatar.className}`}
                    title={agentDisplayName(row.agentId)}
                    aria-hidden
                  >
                    {avatar.initials}
                  </span>
                  <span className="min-w-0 flex-1 truncate text-subtitle font-medium leading-ui text-kin-text">
                    {row.title}
                  </span>
                  {row.remote && (
                    <span
                      className="flex-none text-kin-muted"
                      title={tr("machine.remote")}
                      aria-hidden
                    >
                      <IconMachine size={12} />
                    </span>
                  )}
                  <span className="flex-none text-caption leading-ui text-kin-muted tabular-nums">
                    {formatRelativeTime(row.at, now)}
                  </span>
                </button>
              </li>
            );
          })}
        </ul>
      )}

      {partial && !error && (
        <p role="status" className="mt-2 text-caption text-kin-muted">
          {tr("projects.chatsPartial")}
        </p>
      )}
      {loading && rows.length > 0 && (
        <p className="mt-2 text-caption text-kin-muted" role="status">
          {tr("projects.refreshing")}
        </p>
      )}
    </section>
  );
}
