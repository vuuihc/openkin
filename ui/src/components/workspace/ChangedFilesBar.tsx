import { useEffect, useMemo, useState } from "react";
import {
  summarizeChangedFiles,
  type ChangedFile,
} from "../../lib/changedFiles";
import { useT } from "../../i18n/react";
import { IconCheck, IconChevron, IconX } from "../icons";

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
 * Collapsed-by-default summary of files the agent wrote/edited.
 * Header: "modified N files, +x −y". Click expands the workspace dual-pane
 * (left = changed-file list, right = diff detail with hunk navigation).
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

  // Only count writes/edits/deletes — never surface pure reads.
  const mutated = useMemo(
    () => files.filter((f) => f.action !== "read" && f.action !== "other"),
    [files],
  );
  const stats = useMemo(() => summarizeChangedFiles(mutated), [mutated]);

  const ordered = useMemo(() => {
    return [...mutated].sort((a, b) => {
      const da = (a.additions ?? 0) + (a.deletions ?? 0);
      const db = (b.additions ?? 0) + (b.deletions ?? 0);
      if (db !== da) return db - da;
      return b.seq - a.seq || a.path.localeCompare(b.path);
    });
  }, [mutated]);

  if (mutated.length === 0 || dismissed) return null;

  const labelCount = mutated.length;
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

  /** Open the dual-pane diff panel, focusing the heaviest mutation first. */
  const openDiffPanel = () => {
    const first = ordered[0];
    if (first) {
      onOpenPath(first.path);
    }
    onOpenPanel?.();
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
        <button
          type="button"
          onClick={openDiffPanel}
          title={t("workspace.changed.expand")}
          className="flex-1 min-w-0 flex items-center gap-2 text-left rounded-md -ml-1 pl-1 pr-1 py-0.5 hover:bg-[var(--kin-fill)] focus-visible:outline focus-visible:outline-2 focus-visible:outline-kin-blue"
        >
          <IconChevron
            size={13}
            className="flex-none text-kin-muted rotate-90"
          />
          <span className="flex-none text-[12px] font-semibold text-kin-text">
            {t("workspace.changed.reviewTitle", { count: labelCount })}
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
          <span className="hidden sm:inline flex-none text-[11px] text-kin-muted">
            {t("workspace.changed.expand")}
          </span>
        </button>

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
    </div>
  );
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
