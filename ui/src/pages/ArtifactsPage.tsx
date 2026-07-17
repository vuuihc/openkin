import { useCallback, useEffect, useMemo, useState } from "react";
import { Link, useNavigate } from "react-router-dom";
import {
  ApiError,
  formatBytes,
  getToken,
  listArtifacts,
  setArtifactStatus,
  type Artifact,
} from "../api/client";
import { SlowConnectHint, TaskListSkeleton } from "../components/Skeleton";
import { useSlowHint } from "../hooks/useSlowHint";
import { useT } from "../i18n/react";
import { useAppStore } from "../store/appStore";

type Filter = "saved" | "all" | "archived";

function kindLabel(kind: Artifact["kind"], tr: (k: string) => string): string {
  if (kind === "html") return tr("artifacts.kindHtml");
  if (kind === "text") return tr("artifacts.kindText");
  return tr("artifacts.kindMarkdown");
}

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
 * Artifacts library — list of saved deliverables with archive action.
 */
export default function ArtifactsPage() {
  const navigate = useNavigate();
  const tr = useT();
  const pushToast = useAppStore((s) => s.pushToast);
  const reconnectGen = useAppStore((s) => s.reconnectGen);
  const [items, setItems] = useState<Artifact[] | null>(null);
  const [error, setError] = useState<string | null>(null);
  const [filter, setFilter] = useState<Filter>("saved");
  const [busyId, setBusyId] = useState<string | null>(null);
  const slow = useSlowHint(items === null && !error);

  const load = useCallback(async () => {
    if (!getToken()) return;
    try {
      const status = filter === "all" ? undefined : filter;
      const list = await listArtifacts(status);
      setItems(list);
      setError(null);
    } catch (e) {
      if (e instanceof ApiError && e.status === 401) return;
      setError(e instanceof Error ? e.message : tr("artifacts.loadFailed"));
    }
  }, [filter, tr]);

  useEffect(() => {
    void load();
  }, [load]);

  useEffect(() => {
    if (reconnectGen === 0) return;
    void load();
  }, [reconnectGen, load]);

  const visible = useMemo(() => {
    const list = items ?? [];
    if (filter === "all") {
      return list.filter((a) => a.status !== "archived");
    }
    return list;
  }, [items, filter]);

  const onArchive = async (id: string, e: { preventDefault(): void; stopPropagation(): void }) => {
    e.preventDefault();
    e.stopPropagation();
    setBusyId(id);
    try {
      await setArtifactStatus(id, "archived");
      pushToast(tr("artifacts.archived"), "info");
      await load();
    } catch (err) {
      pushToast(
        err instanceof Error ? err.message : tr("artifacts.archiveFailed"),
        "error",
      );
    } finally {
      setBusyId(null);
    }
  };

  return (
    <div className="flex-1 overflow-y-auto kin-scroll">
      <div className="max-w-4xl mx-auto px-4 sm:px-6 py-6 sm:py-8">
        <div className="flex flex-wrap items-end justify-between gap-3">
          <div>
            <h1 className="text-[22px] font-semibold tracking-tight">
              {tr("artifacts.title")}
            </h1>
            <p className="text-[13px] text-kin-tertiary mt-0.5">
              {tr("artifacts.subtitle")}
            </p>
          </div>
        </div>

        <div className="mt-5 flex gap-1.5">
          {(
            [
              ["saved", tr("artifacts.filterSaved")],
              ["all", tr("artifacts.filterAll")],
              ["archived", tr("artifacts.filterArchived")],
            ] as const
          ).map(([k, label]) => (
            <button
              key={k}
              type="button"
              onClick={() => setFilter(k)}
              className={[
                "px-3 py-1.5 rounded-lg text-[13px] font-medium min-h-[36px]",
                filter === k
                  ? "bg-kin-blue text-white"
                  : "text-kin-secondary hover:bg-[var(--kin-fill)]",
              ].join(" ")}
            >
              {label}
            </button>
          ))}
        </div>

        {error && (
          <p className="mt-4 text-[13px] text-kin-red">{error}</p>
        )}
        {items === null && !error && (
          <div className="mt-6">
            {slow ? <SlowConnectHint show /> : <TaskListSkeleton />}
          </div>
        )}
        {items && visible.length === 0 && (
          <p className="mt-10 text-center text-[14px] text-kin-muted">
            {tr("artifacts.empty")}
          </p>
        )}
        {items && visible.length > 0 && (
          <ul className="mt-5 space-y-1.5">
            {visible.map((a) => (
              <li key={a.id}>
                <div
                  role="button"
                  tabIndex={0}
                  onClick={() => navigate(`/artifacts/${a.id}`)}
                  onKeyDown={(e) => {
                    if (e.key === "Enter" || e.key === " ") {
                      e.preventDefault();
                      navigate(`/artifacts/${a.id}`);
                    }
                  }}
                  className="w-full text-left rounded-xl border border-[var(--kin-hairline)] bg-[var(--kin-surface)] hover:bg-[var(--kin-fill)] px-3.5 py-3 flex items-start gap-3 cursor-pointer"
                >
                  <div className="min-w-0 flex-1">
                    <div className="flex items-center gap-2 flex-wrap">
                      <span className="text-[14.5px] font-medium text-kin-text truncate">
                        {a.title}
                      </span>
                      <span className="text-[11px] font-medium px-1.5 py-0.5 rounded-md bg-[var(--kin-fill-strong)] text-kin-secondary">
                        {kindLabel(a.kind, tr)}
                      </span>
                      {a.status === "proposed" && (
                        <span className="text-[11px] text-kin-muted">
                          {tr("artifacts.statusProposed")}
                        </span>
                      )}
                    </div>
                    <div className="mt-1 flex flex-wrap items-center gap-x-2 gap-y-0.5 text-[12px] text-kin-muted">
                      <span>{formatWhen(a.created_at)}</span>
                      <span>·</span>
                      <span>{formatBytes(a.size)}</span>
                      {a.source_task_id && (
                        <>
                          <span>·</span>
                          <Link
                            to={`/tasks/${a.source_task_id}`}
                            onClick={(e) => e.stopPropagation()}
                            className="text-kin-blue hover:underline truncate max-w-[220px]"
                          >
                            {a.source_task_title || tr("artifacts.sourceTask")}
                          </Link>
                        </>
                      )}
                    </div>
                  </div>
                  {a.status !== "archived" && (
                    <button
                      type="button"
                      disabled={busyId === a.id}
                      onClick={(e) => void onArchive(a.id, e)}
                      className="shrink-0 px-2.5 py-1 rounded-md text-[12px] font-medium text-kin-muted hover:text-kin-text hover:bg-[var(--kin-fill-strong)] disabled:opacity-40"
                    >
                      {tr("artifacts.archive")}
                    </button>
                  )}
                </div>
              </li>
            ))}
          </ul>
        )}
      </div>
    </div>
  );
}
