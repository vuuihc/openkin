import { useEffect, useMemo, useState } from "react";
import { shortPath } from "../../lib/paths";
import {
  summarizeChangedFiles,
  type ChangedFile,
} from "../../lib/changedFiles";
import { useT } from "../../i18n/react";
import { IconCheck, IconFile, IconX } from "../icons";

type Props = {
  files: ChangedFile[];
  onOpenPath: (path: string) => void;
  onOpenPanel?: () => void;
  /**
   * When true, show Keep / Discard bulk actions (isolated worktree + terminal task).
   * Keep is a soft acknowledgment (clears the review card); Discard rewinds files.
   */
  reviewActions?: boolean;
  onKeepAll?: () => void | Promise<void>;
  onDiscardAll?: () => void | Promise<void>;
  actionsBusy?: boolean;
  className?: string;
};

/**
 * Review card summarizing files the agent touched.
 * Header: count + total +/- + bulk keep/discard.
 * Body: per-file rows with deltas; click opens the workspace diff panel.
 */
export default function ChangedFilesBar({
  files,
  onOpenPath,
  onOpenPanel,
  reviewActions = false,
  onKeepAll,
  onDiscardAll,
  actionsBusy = false,
  className,
}: Props) {
  const t = useT();
  const [dismissed, setDismissed] = useState(false);
  const [confirmDiscard, setConfirmDiscard] = useState(false);

  // Re-show the card when the agent touches a new set of files.
  const filesKey = useMemo(
    () =>
      files
        .map((f) => `${f.action}:${f.path}:${f.seq}`)
        .sort()
        .join("|"),
    [files],
  );
  useEffect(() => {
    setDismissed(false);
    setConfirmDiscard(false);
  }, [filesKey]);

  const mutated = useMemo(
    () => files.filter((f) => f.action !== "read"),
    [files],
  );
  const focus = useMemo(
    () => (mutated.length > 0 ? mutated : files),
    [mutated, files],
  );
  const stats = useMemo(() => summarizeChangedFiles(focus), [focus]);

  const ordered = useMemo(() => {
    return [...focus].sort((a, b) => {
      const da = (a.additions ?? 0) + (a.deletions ?? 0);
      const db = (b.additions ?? 0) + (b.deletions ?? 0);
      if (db !== da) return db - da;
      return b.seq - a.seq || a.path.localeCompare(b.path);
    });
  }, [focus]);

  if (files.length === 0 || dismissed) return null;

  const labelCount = focus.length;
  const titleKey =
    mutated.length > 0
      ? "workspace.changed.reviewTitle"
      : "workspace.changed.viewedTitle";
  const showBulk = reviewActions && mutated.length > 0;

  const handleKeepAll = async () => {
    try {
      await onKeepAll?.();
    } finally {
      setDismissed(true);
      setConfirmDiscard(false);
    }
  };

  const handleDiscardAll = async () => {
    if (!onDiscardAll) {
      setDismissed(true);
      return;
    }
    if (!confirmDiscard) {
      setConfirmDiscard(true);
      return;
    }
    try {
      await onDiscardAll();
      setDismissed(true);
    } finally {
      setConfirmDiscard(false);
    }
  };

  return (
    <div
      className={[
        "flex-none border-b border-[var(--kin-hairline)]",
        "bg-[var(--kin-elevated)]/60",
        className ?? "",
      ].join(" ")}
    >
      <div className="px-4 sm:px-5 py-2.5 flex items-center gap-2 min-w-0">
        <div className="flex-1 min-w-0 flex items-center gap-2">
          <span className="flex-none text-[12px] font-semibold text-kin-text">
            {t(titleKey, { count: labelCount })}
          </span>
          {stats.hasStats && (stats.additions > 0 || stats.deletions > 0) && (
            <span className="flex-none text-[12px] font-mono tabular-nums">
              <DeltaInline
                additions={stats.additions}
                deletions={stats.deletions}
              />
            </span>
          )}
          {stats.hasStats && stats.additions === 0 && stats.deletions === 0 && (
            <span className="flex-none text-[11px] text-kin-muted">
              {t("workspace.changed.noLineDelta")}
            </span>
          )}
        </div>

        {showBulk && (
          <div className="flex-none flex items-center gap-1.5">
            {confirmDiscard ? (
              <>
                <span className="hidden sm:inline text-[11px] text-kin-muted mr-0.5">
                  {t("workspace.changed.discardConfirmShort")}
                </span>
                <button
                  type="button"
                  disabled={actionsBusy}
                  onClick={() => void handleDiscardAll()}
                  className="kin-btn-deny !min-h-0 !py-1 !px-2.5 text-[11.5px] disabled:opacity-50"
                >
                  {t("workspace.changed.discardConfirm")}
                </button>
                <button
                  type="button"
                  disabled={actionsBusy}
                  onClick={() => setConfirmDiscard(false)}
                  className="kin-btn-secondary !min-h-0 !py-1 !px-2.5 text-[11.5px] disabled:opacity-50"
                >
                  {t("workspace.changed.discardCancel")}
                </button>
              </>
            ) : (
              <>
                <button
                  type="button"
                  disabled={actionsBusy}
                  onClick={() => void handleDiscardAll()}
                  title={t("workspace.changed.discardAllHint")}
                  className="kin-btn-secondary !min-h-0 !py-1 !px-2.5 text-[11.5px] disabled:opacity-50"
                >
                  <IconX size={12} className="opacity-80" />
                  {t("workspace.changed.discardAll")}
                </button>
                <button
                  type="button"
                  disabled={actionsBusy}
                  onClick={() => void handleKeepAll()}
                  title={t("workspace.changed.keepAllHint")}
                  className="kin-btn-primary !min-h-0 !py-1 !px-2.5 text-[11.5px] disabled:opacity-50"
                >
                  <IconCheck size={12} />
                  {t("workspace.changed.keepAll")}
                </button>
              </>
            )}
          </div>
        )}

        {!showBulk && (
          <button
            type="button"
            onClick={() => setDismissed(true)}
            aria-label={t("workspace.changed.dismiss")}
            className="flex-none p-1 rounded-md text-kin-muted hover:text-kin-text hover:bg-[var(--kin-fill)]"
          >
            <IconX size={13} />
          </button>
        )}
      </div>

      <ul className="px-2 sm:px-3 pb-2 space-y-0.5 max-h-[40vh] overflow-y-auto kin-scroll">
        {ordered.map((f) => {
          const hasDelta = f.additions != null || f.deletions != null;
          return (
            <li key={`${f.action}:${f.path}`}>
              <button
                type="button"
                onClick={() => {
                  onOpenPath(f.path);
                  onOpenPanel?.();
                }}
                title={
                  hasDelta
                    ? `${f.path} (${formatDelta(f.additions ?? 0, f.deletions ?? 0)})`
                    : f.path
                }
                className={[
                  "w-full flex items-center gap-2 min-w-0 rounded-lg px-2.5 py-1.5",
                  "text-left transition-colors",
                  "hover:bg-[var(--kin-fill)] focus-visible:outline focus-visible:outline-2 focus-visible:outline-kin-blue",
                ].join(" ")}
              >
                <span
                  className={[
                    "flex-none w-1.5 h-1.5 rounded-full",
                    actionDot(f.action),
                  ].join(" ")}
                  aria-hidden
                />
                <IconFile size={13} className="flex-none opacity-70 text-kin-secondary" />
                <span className="flex-1 min-w-0 truncate text-[12.5px] font-mono text-kin-text">
                  {shortPath(f.path, 56)}
                </span>
                <span className="flex-none text-[10px] uppercase tracking-wide text-kin-muted">
                  {actionLabel(f.action, t)}
                </span>
                {hasDelta && (
                  <span className="flex-none text-[11.5px] font-mono tabular-nums">
                    <DeltaInline
                      additions={f.additions ?? 0}
                      deletions={f.deletions ?? 0}
                    />
                  </span>
                )}
              </button>
            </li>
          );
        })}
      </ul>
    </div>
  );
}

function formatDelta(additions: number, deletions: number): string {
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
      {additions > 0 && deletions > 0 && (
        <span className="text-kin-muted"> </span>
      )}
      {deletions > 0 && <span className="text-[#ffb4ad]">−{deletions}</span>}
    </span>
  );
}

function actionDot(action: ChangedFile["action"]): string {
  switch (action) {
    case "write":
      return "bg-[#8de4a0]";
    case "edit":
      return "bg-[#7cbcff]";
    case "delete":
      return "bg-[#ffb4ad]";
    case "read":
      return "bg-kin-muted";
    default:
      return "bg-kin-muted";
  }
}

function actionLabel(
  action: ChangedFile["action"],
  t: (
    path: string,
    params?: Record<string, string | number | null | undefined>,
  ) => string,
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
