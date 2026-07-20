import { useId, useMemo, useState } from "react";
import { shortPath } from "../../lib/paths";
import {
  summarizeChangedFiles,
  type ChangedFile,
} from "../../lib/changedFiles";
import { useT } from "../../i18n/react";
import { IconFile, IconPanel } from "../icons";

type Props = {
  files: ChangedFile[];
  onOpenPath: (path: string) => void;
  onOpenPanel?: () => void;
  /** Compact single-row chips under the task header. */
  className?: string;
};

/**
 * Collapsed-by-default summary of files the agent touched.
 * Shows file count + best-effort +/- line stats; expand for per-file chips.
 */
export default function ChangedFilesBar({
  files,
  onOpenPath,
  onOpenPanel,
  className,
}: Props) {
  const t = useT();
  const [open, setOpen] = useState(false);
  const detailsID = useId();

  // Hooks must run unconditionally — early return only after all hooks.
  const mutated = useMemo(
    () => files.filter((f) => f.action !== "read"),
    [files],
  );
  const focus = useMemo(
    () => (mutated.length > 0 ? mutated : files),
    [mutated, files],
  );
  const stats = useMemo(() => summarizeChangedFiles(focus), [focus]);

  // Compact glance when collapsed: "+12 −3 · a.ts · b.go +2"
  const glance = useMemo(() => {
    if (files.length === 0) return "";
    const parts: string[] = [];
    if (stats.hasStats && (stats.additions > 0 || stats.deletions > 0)) {
      parts.push(formatDelta(stats.additions, stats.deletions));
    } else if (stats.hasStats) {
      parts.push(t("workspace.changed.noLineDelta"));
    }

    // Top files by |delta|, fallback order as given.
    const ranked = [...focus].sort((a, b) => {
      const da = (a.additions ?? 0) + (a.deletions ?? 0);
      const db = (b.additions ?? 0) + (b.deletions ?? 0);
      if (db !== da) return db - da;
      return b.seq - a.seq;
    });
    const shown = ranked.slice(0, 2).map((f) => {
      const name = shortPath(f.path, 22);
      const d =
        f.additions != null || f.deletions != null
          ? ` ${formatDelta(f.additions ?? 0, f.deletions ?? 0)}`
          : "";
      return `${name}${d}`;
    });
    if (shown.length) parts.push(shown.join(" · "));
    if (ranked.length > 2) parts.push(`+${ranked.length - 2}`);
    return parts.join(" · ");
  }, [files.length, focus, stats, t]);

  if (files.length === 0) return null;

  const labelCount = focus.length;
  const titleKey =
    mutated.length > 0 ? "workspace.changed.title" : "workspace.changed.viewedTitle";

  return (
    <div
      className={[
        "flex-none border-b border-[var(--kin-hairline)] bg-[var(--kin-fill)]/80",
        className ?? "",
      ].join(" ")}
    >
      <div className="px-4 sm:px-5 py-1.5 flex items-center gap-2 min-w-0">
        <button
          type="button"
          aria-expanded={open}
          aria-controls={detailsID}
          onClick={() => setOpen((v) => !v)}
          className="flex-1 min-w-0 flex items-center gap-2 text-left rounded-md px-0.5 py-0.5 hover:bg-black/[.03] dark:hover:bg-white/[.03] focus-visible:outline focus-visible:outline-2 focus-visible:outline-kin-blue"
        >
          <span className="flex-none text-[11px] font-semibold uppercase tracking-wide text-kin-muted">
            {t(titleKey, { count: labelCount })}
          </span>
          {!open && (
            <span
              className="flex-1 min-w-0 truncate text-[11.5px] font-mono text-kin-secondary"
              title={focus
                .map((f) => {
                  const d =
                    f.additions != null || f.deletions != null
                      ? ` ${formatDelta(f.additions ?? 0, f.deletions ?? 0)}`
                      : "";
                  return `${f.path}${d}`;
                })
                .join("\n")}
            >
              {glance}
            </span>
          )}
          {open && (
            <span className="flex-1 min-w-0 truncate text-[11.5px] font-mono text-kin-secondary">
              {stats.hasStats
                ? formatDelta(stats.additions, stats.deletions)
                : null}
            </span>
          )}
          <span className="flex-none text-[11px] text-kin-muted tabular-nums">
            {open ? t("workspace.changed.collapse") : t("workspace.changed.expand")}
          </span>
        </button>
        {onOpenPanel && (
          <button
            type="button"
            onClick={onOpenPanel}
            className="flex-none inline-flex items-center gap-1 text-[11.5px] text-kin-blue hover:underline"
            title={t("workspace.toggle")}
          >
            <IconPanel size={12} />
            <span className="hidden sm:inline">{t("workspace.title")}</span>
          </button>
        )}
      </div>

      {open && (
        <div id={detailsID} className="px-4 sm:px-5 pb-2 flex flex-wrap gap-1.5">
          {files.map((f) => (
            <button
              key={`${f.action}:${f.path}`}
              type="button"
              onClick={() => onOpenPath(f.path)}
              title={
                f.additions != null || f.deletions != null
                  ? `${f.path} (${formatDelta(f.additions ?? 0, f.deletions ?? 0)})`
                  : f.path
              }
              className={[
                "inline-flex items-center gap-1 max-w-full rounded-md border px-2 py-0.5",
                "text-[11.5px] font-mono transition-colors",
                chipClass(f.action),
              ].join(" ")}
            >
              <IconFile size={11} className="flex-none opacity-80" />
              <span className="truncate">{shortPath(f.path, 42)}</span>
              <span className="flex-none text-[10px] uppercase opacity-70">
                {actionLabel(f.action, t)}
              </span>
              {(f.additions != null || f.deletions != null) && (
                <span className="flex-none text-[10px] tabular-nums opacity-90">
                  <DeltaInline additions={f.additions ?? 0} deletions={f.deletions ?? 0} />
                </span>
              )}
            </button>
          ))}
        </div>
      )}
    </div>
  );
}

function formatDelta(additions: number, deletions: number): string {
  // Prefer compact: "+12 −3"; omit zero side only when the other is non-zero.
  if (additions === 0 && deletions === 0) return "+0 −0";
  if (additions > 0 && deletions === 0) return `+${additions}`;
  if (deletions > 0 && additions === 0) return `−${deletions}`;
  return `+${additions} −${deletions}`;
}

function DeltaInline({
  additions,
  deletions,
}: {
  additions: number;
  deletions: number;
}) {
  if (additions === 0 && deletions === 0) {
    return <span className="text-kin-muted">±0</span>;
  }
  return (
    <span>
      {additions > 0 && <span className="text-[#8de4a0]">+{additions}</span>}
      {additions > 0 && deletions > 0 && <span className="text-kin-muted"> </span>}
      {deletions > 0 && <span className="text-[#ffb4ad]">−{deletions}</span>}
    </span>
  );
}

function chipClass(action: ChangedFile["action"]): string {
  switch (action) {
    case "write":
      return "border-[rgba(50,215,75,.35)] bg-[rgba(50,215,75,.08)] text-[#8de4a0] hover:bg-[rgba(50,215,75,.14)]";
    case "edit":
      return "border-[rgba(10,132,255,.35)] bg-[rgba(10,132,255,.08)] text-[#7cbcff] hover:bg-[rgba(10,132,255,.14)]";
    case "delete":
      return "border-[rgba(255,69,58,.35)] bg-[rgba(255,69,58,.08)] text-[#ffb4ad] hover:bg-[rgba(255,69,58,.14)]";
    case "read":
      return "border-[var(--kin-hairline-strong)] bg-black/[.03] dark:bg-white/[.04] text-kin-secondary hover:bg-black/[.05] dark:hover:bg-white/[.06]";
    default:
      return "border-[var(--kin-hairline-strong)] bg-black/[.03] dark:bg-white/[.04] text-kin-secondary";
  }
}

function actionLabel(
  action: ChangedFile["action"],
  t: (path: string, params?: Record<string, string | number | null | undefined>) => string,
): string {
  switch (action) {
    case "write":
      return t("workspace.changed.write");
    case "edit":
      return t("workspace.changed.edit");
    case "delete":
      return t("workspace.changed.delete");
    case "read":
      return t("workspace.changed.read");
    default:
      return t("workspace.changed.other");
  }
}
