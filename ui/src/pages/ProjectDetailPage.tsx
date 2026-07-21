import { useCallback, useEffect, useState } from "react";
import { Link, useNavigate, useParams } from "react-router-dom";
import {
  ApiError,
  continueProject,
  getOnePager,
  getProject,
  getToken,
  listProjectArtifacts,
  listProjectTasks,
  patchProject,
  putOnePager,
  type Artifact,
  type Project,
  type ProjectMode,
  type Task,
} from "../api/client";
import { IconBack } from "../components/icons";
import Markdown from "../components/Markdown";
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
 * Project home — One-Pager cover + continue focus + recent sessions.
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
  const [tasks, setTasks] = useState<Task[]>([]);
  const [artifacts, setArtifacts] = useState<Artifact[]>([]);
  const [error, setError] = useState<string | null>(null);
  const [loading, setLoading] = useState(true);
  const [editing, setEditing] = useState(false);
  const [draft, setDraft] = useState("");
  const [saving, setSaving] = useState(false);
  const [continuing, setContinuing] = useState(false);
  const slow = useSlowHint(loading);

  const load = useCallback(async () => {
    if (!getToken() || !id) return;
    setLoading(true);
    try {
      const [p, op, ts, arts] = await Promise.all([
        getProject(id),
        getOnePager(id),
        listProjectTasks(id, 30),
        listProjectArtifacts(id, 20),
      ]);
      setProject(p);
      setMarkdown(op.markdown);
      setUpdatedAt(op.updated_at);
      setTasks(ts);
      setArtifacts(arts);
      setDraft(op.markdown);
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
  }, [id, tr]);

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
        pushToast(e instanceof Error ? e.message : tr("projects.saveFailed"), "error");
      }
    } finally {
      setSaving(false);
    }
  };

  const onContinue = async () => {
    if (!id || !project) return;
    setContinuing(true);
    try {
      const t = await continueProject(id, {
        cwd: project.roots?.[0],
      });
      navigate(`/tasks/${t.id}`);
    } catch (e) {
      pushToast(e instanceof Error ? e.message : tr("projects.continueFailed"), "error");
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

  const onSoftProgress = async (soft: string) => {
    if (!id) return;
    try {
      const p = await patchProject(id, { soft_progress: soft });
      setProject(p);
    } catch (e) {
      pushToast(e instanceof Error ? e.message : "failed", "error");
    }
  };

  if (loading) {
    return (
      <div className="mx-auto max-w-4xl px-4 py-6 space-y-3">
        {slow && <SlowConnectHint show />}
        <SkeletonLine />
        <SkeletonLine />
        <SkeletonLine />
      </div>
    );
  }

  if (error || !project) {
    return (
      <div className="mx-auto max-w-4xl px-4 py-6">
        <button
          type="button"
          className="mb-4 inline-flex items-center gap-1 text-[13px] text-kin-secondary hover:text-kin-text"
          onClick={() => { if (window.history.length > 1) navigate(-1); else navigate("/new"); }}
        >
          <IconBack size={14} />
          {tr("projects.title")}
        </button>
        <div className="rounded-lg border border-red-500/30 bg-red-500/10 px-3 py-2 text-[13px] text-red-300">
          {error || tr("projects.notFound")}
        </div>
      </div>
    );
  }

  return (
    <div className="mx-auto max-w-4xl px-4 py-6">
      <button
        type="button"
        className="mb-3 inline-flex items-center gap-1 text-[13px] text-kin-secondary hover:text-kin-text"
        onClick={() => { if (window.history.length > 1) navigate(-1); else navigate("/new"); }}
      >
        <IconBack size={14} />
        {tr("projects.title")}
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
          <select
            className="rounded-lg border border-kin-border bg-transparent px-2 py-1.5 text-[12.5px] text-kin-text"
            value={project.soft_progress || ""}
            onChange={(e) => void onSoftProgress(e.target.value)}
          >
            <option value="">{tr("projects.softProgress")}</option>
            <option value="fog">{tr("projects.softFog")}</option>
            <option value="can_explain">{tr("projects.softCanExplain")}</option>
            <option value="can_build">{tr("projects.softCanBuild")}</option>
            <option value="can_ship">{tr("projects.softCanShip")}</option>
            <option value="can_teach">{tr("projects.softCanTeach")}</option>
          </select>
          <button
            type="button"
            disabled={continuing}
            className="rounded-lg bg-kin-accent px-3 py-1.5 text-[13px] font-medium text-white disabled:opacity-50"
            onClick={() => void onContinue()}
          >
            {tr("projects.continueFocus")}
          </button>
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

      <div className="grid gap-4 lg:grid-cols-[1fr_280px]">
        <section className="rounded-xl border border-kin-border bg-kin-panel p-4 min-h-[320px]">
          <div className="mb-2 text-[12px] font-medium uppercase tracking-wide text-kin-secondary">
            {tr("projects.onePager")}
          </div>
          {editing ? (
            <textarea
              className="min-h-[420px] w-full resize-y rounded-lg border border-kin-border bg-transparent p-3 font-mono text-[12.5px] leading-relaxed text-kin-text"
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
              {tr("projects.recentSessions")}
            </div>
            {tasks.length === 0 ? (
              <div className="text-[12.5px] text-kin-secondary">
                {tr("projects.noSessions")}
              </div>
            ) : (
              <ul className="space-y-1.5">
                {tasks.map((t) => (
                  <li key={t.id}>
                    <Link
                      to={`/tasks/${t.id}`}
                      className="block rounded-lg px-2 py-1.5 hover:bg-[var(--kin-fill-strong)]"
                    >
                      <div className="truncate text-[12.5px] text-kin-text">
                        {t.title || t.prompt}
                      </div>
                      <div className="mt-0.5 text-[11px] text-kin-secondary">
                        {t.status} · {formatWhen(t.created_at)}
                      </div>
                    </Link>
                  </li>
                ))}
              </ul>
            )}
          </section>
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
  );
}
