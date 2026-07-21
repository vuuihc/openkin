import { useCallback, useEffect, useState } from "react";
import { Link, useNavigate } from "react-router-dom";
import {
  ApiError,
  ensureProject,
  getToken,
  listProjects,
  type Project,
  type ProjectMode,
} from "../api/client";
import CwdPicker from "../components/chat/CwdPicker";
import { SlowConnectHint, TaskListSkeleton } from "../components/Skeleton";
import { useSlowHint } from "../hooks/useSlowHint";
import { useT } from "../i18n/react";
import { projectLabel } from "../lib/paths";
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

function modeLabel(mode: string, tr: (k: string) => string): string {
  switch (mode) {
    case "learn":
      return tr("projects.modeLearn");
    case "explore":
      return tr("projects.modeExplore");
    case "maintain":
      return tr("projects.modeMaintain");
    default:
      return tr("projects.modeShip");
  }
}

/**
 * Projects — living One-Pager covers for working directories.
 * A project is the durable face of a cwd group (sidebar project), not a separate universe.
 */
export default function ProjectsPage() {
  const navigate = useNavigate();
  const tr = useT();
  const pushToast = useAppStore((s) => s.pushToast);
  const reconnectGen = useAppStore((s) => s.reconnectGen);
  const [items, setItems] = useState<Project[] | null>(null);
  const [error, setError] = useState<string | null>(null);
  const [creating, setCreating] = useState(false);
  const [cwd, setCwd] = useState("");
  const [mode, setMode] = useState<ProjectMode>("ship");
  const [busy, setBusy] = useState(false);
  const slow = useSlowHint(items === null && !error);

  const load = useCallback(async () => {
    if (!getToken()) return;
    try {
      const list = await listProjects("active");
      setItems(list);
      setError(null);
    } catch (e) {
      if (e instanceof ApiError && e.status === 401) return;
      setError(e instanceof Error ? e.message : tr("projects.loadFailed"));
      setItems([]);
    }
  }, [tr]);

  useEffect(() => {
    void load();
  }, [load, reconnectGen]);

  const onOpenOrCreate = async () => {
    const path = cwd.trim();
    if (!path) return;
    setBusy(true);
    try {
      const p = await ensureProject({
        path,
        name: projectLabel(path),
        mode,
      });
      setCreating(false);
      navigate(`/projects/${p.id}`);
    } catch (e) {
      pushToast(
        e instanceof Error ? e.message : tr("projects.createFailed"),
        "error",
      );
    } finally {
      setBusy(false);
    }
  };

  return (
    <div className="mx-auto max-w-3xl px-4 py-6">
      <div className="mb-4 flex flex-wrap items-center justify-between gap-3">
        <div>
          <h1 className="text-lg font-semibold text-kin-text">
            {tr("projects.title")}
          </h1>
          <p className="mt-1 text-[12.5px] text-kin-secondary">
            {tr("projects.optionalHint")}
          </p>
        </div>
        <button
          type="button"
          className="rounded-lg bg-kin-accent px-3 py-1.5 text-[13px] font-medium text-white hover:opacity-90"
          onClick={() => setCreating((v) => !v)}
        >
          {tr("projects.create")}
        </button>
      </div>

      {creating && (
        <div className="mb-5 rounded-xl border border-kin-border bg-kin-panel p-4 space-y-3">
          <div className="text-[13px] font-medium text-kin-text">
            {tr("projects.createTitle")}
          </div>
          <p className="text-[12px] text-kin-secondary">
            {tr("projects.createFromCwdHint")}
          </p>
          <div>
            <div className="mb-1 text-[12px] text-kin-secondary">
              {tr("projects.root")}
            </div>
            <CwdPicker cwd={cwd} onChange={setCwd} />
          </div>
          <label className="block text-[12px] text-kin-secondary">
            {tr("projects.mode")}
            <select
              className="mt-1 w-full rounded-lg border border-kin-border bg-transparent px-3 py-2 text-[13px] text-kin-text"
              value={mode}
              onChange={(e) => setMode(e.target.value as ProjectMode)}
            >
              <option value="ship">{tr("projects.modeShip")}</option>
              <option value="learn">{tr("projects.modeLearn")}</option>
              <option value="explore">{tr("projects.modeExplore")}</option>
              <option value="maintain">{tr("projects.modeMaintain")}</option>
            </select>
          </label>
          <div className="flex gap-2">
            <button
              type="button"
              disabled={busy || !cwd.trim()}
              className="rounded-lg bg-kin-accent px-3 py-1.5 text-[13px] font-medium text-white disabled:opacity-50"
              onClick={() => void onOpenOrCreate()}
            >
              {tr("projects.openOrCreate")}
            </button>
            <button
              type="button"
              className="rounded-lg px-3 py-1.5 text-[13px] text-kin-secondary hover:bg-[var(--kin-fill-strong)]"
              onClick={() => setCreating(false)}
            >
              {tr("projects.cancelEdit")}
            </button>
          </div>
        </div>
      )}

      {items === null && !error && (
        <div>
          {slow ? <SlowConnectHint show /> : <TaskListSkeleton />}
        </div>
      )}

      {error && (
        <div className="rounded-lg border border-red-500/30 bg-red-500/10 px-3 py-2 text-[13px] text-red-300">
          {error}
        </div>
      )}

      {items && items.length === 0 && !error && (
        <div className="rounded-xl border border-dashed border-kin-border px-4 py-10 text-center text-[13px] text-kin-secondary">
          {tr("projects.empty")}
        </div>
      )}

      {items && items.length > 0 && (
        <ul className="space-y-2">
          {items.map((p) => (
            <li key={p.id}>
              <Link
                to={`/projects/${p.id}`}
                className="block rounded-xl border border-kin-border bg-kin-panel px-4 py-3 hover:border-kin-accent/40 transition-colors"
              >
                <div className="flex items-start justify-between gap-3">
                  <div>
                    <div className="text-[14px] font-medium text-kin-text">
                      {p.name}
                    </div>
                    <div className="mt-1 flex flex-wrap gap-2 text-[11.5px] text-kin-secondary">
                      <span className="rounded-md bg-[var(--kin-fill-strong)] px-1.5 py-0.5">
                        {modeLabel(p.mode, tr)}
                      </span>
                      {p.soft_progress && (
                        <span>{p.soft_progress.replaceAll("_", " ")}</span>
                      )}
                      {p.roots?.[0] && (
                        <span
                          className="truncate max-w-[240px]"
                          title={p.roots[0]}
                        >
                          {p.roots[0]}
                        </span>
                      )}
                    </div>
                  </div>
                  <div className="shrink-0 text-[11.5px] text-kin-secondary">
                    {formatWhen(p.last_active_at)}
                  </div>
                </div>
              </Link>
            </li>
          ))}
        </ul>
      )}
    </div>
  );
}
