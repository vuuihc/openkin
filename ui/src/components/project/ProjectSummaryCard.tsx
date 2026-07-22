import { Link } from "react-router-dom";
import type { OnePagerSummary, Project } from "../../api/client";
import { useT } from "../../i18n/react";

type Props = {
  project: Project;
  summary?: OnePagerSummary | null;
  loading?: boolean;
  error?: string | null;
  onRetry?: () => void;
  className?: string;
};

export default function ProjectSummaryCard({
  project,
  summary,
  loading,
  error,
  onRetry,
  className = "",
}: Props) {
  const tr = useT();
  const name = summary?.name || project.name;
  const mode = summary?.mode || project.mode;
  const empty = summary?.empty !== false && !summary?.north_star && !summary?.focus && !(summary?.next?.length);

  return (
    <div
      className={[
        "w-full max-w-xl rounded-2xl border border-[var(--kin-hairline)] bg-kin-panel/80 px-4 py-3 text-left shadow-sm",
        className,
      ].join(" ")}
    >
      <div className="flex items-start justify-between gap-3">
        <div className="min-w-0">
          <div className="text-[11px] font-medium uppercase tracking-wide text-kin-secondary">
            {tr("newChat.projectSummaryLabel")}
          </div>
          <div className="mt-0.5 truncate text-[14px] font-semibold text-kin-text">
            {name}
          </div>
          <div className="mt-0.5 text-[11.5px] text-kin-muted">
            {tr("newChat.projectMode", { mode: String(mode || "ship") })}
          </div>
        </div>
        <Link
          to={`/projects/${encodeURIComponent(project.id)}`}
          className="flex-none rounded-lg border border-[var(--kin-hairline)] px-2.5 py-1 text-[12px] text-kin-secondary hover:bg-[var(--kin-fill)] hover:text-kin-text"
        >
          {tr("newChat.openOnePager")}
        </Link>
      </div>

      {loading ? (
        <p className="mt-3 text-[12.5px] text-kin-muted">{tr("newChat.projectSummaryLoading")}</p>
      ) : error ? (
        <div className="mt-3 flex items-center justify-between gap-2">
          <p className="text-[12.5px] text-red-500/90">{error}</p>
          {onRetry && (
            <button
              type="button"
              onClick={onRetry}
              className="text-[12px] text-kin-accent hover:underline"
            >
              {tr("common.retry")}
            </button>
          )}
        </div>
      ) : empty ? (
        <p className="mt-3 text-[12.5px] text-kin-secondary">
          {tr("newChat.projectSummaryEmpty")}
        </p>
      ) : (
        <div className="mt-3 space-y-2 text-[12.5px] leading-relaxed">
          {summary?.north_star ? (
            <div>
              <div className="text-[11px] font-medium text-kin-muted">
                {tr("newChat.summaryNorthStar")}
              </div>
              <div className="text-kin-text">{summary.north_star}</div>
            </div>
          ) : null}
          {summary?.focus ? (
            <div>
              <div className="text-[11px] font-medium text-kin-muted">
                {tr("newChat.summaryFocus")}
              </div>
              <div className="text-kin-text">{summary.focus}</div>
            </div>
          ) : null}
          {summary?.next && summary.next.length > 0 ? (
            <div>
              <div className="text-[11px] font-medium text-kin-muted">
                {tr("newChat.summaryNext")}
              </div>
              <ol className="mt-0.5 list-decimal space-y-0.5 pl-4 text-kin-text">
                {summary.next.slice(0, 3).map((item, i) => (
                  <li key={i}>{item}</li>
                ))}
              </ol>
            </div>
          ) : null}
        </div>
      )}
    </div>
  );
}
