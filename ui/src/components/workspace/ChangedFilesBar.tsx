import { useEffect, useMemo, useState } from "react";
import { summarizeChangedFiles, type ChangedFile } from "../../lib/changedFiles";
import { useT } from "../../i18n/react";
import DeltaInline, { FileSize } from "../changedFileFace";
import { IconCheck, IconChevron, IconX } from "../icons";
import Button from "../ui/Button";
import { fileBaseName } from "./workspacePreview";

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
  /** bar = chat-column strip; card = side-rail panel (Codex-style). */
  variant?: "bar" | "card";
};

/**
 * Summary of files the agent wrote/edited.
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
  variant = "bar",
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
  const isCard = variant === "card";
  const preview = ordered.slice(0, isCard ? 6 : 0);

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
  const openDiffPanel = (path?: string) => {
    if (path) {
      onOpenPath(path);
    } else {
      const first = ordered[0];
      if (first) onOpenPath(first.path);
    }
    onOpenPanel?.();
  };

  const bulkActions = showBulk ? (
    <div className="flex-none flex items-center gap-1.5 flex-wrap justify-end">
      {confirmDiscard ? (
        <>
          <span className="hidden sm:inline text-caption text-kin-muted mr-0.5">
            {t("workspace.changed.discardConfirmShort")}
          </span>
          <Button
            variant="deny"
            disabled={actionsBusy}
            onClick={() => void handleDiscardAll()}
            className="md:min-h-0 md:px-2.5 md:py-1 text-caption"
          >
            {t("workspace.changed.discardConfirm")}
          </Button>
          <Button
            variant="secondary"
            disabled={actionsBusy}
            onClick={() => setConfirmDiscard(false)}
            className="md:min-h-0 md:px-2.5 md:py-1 text-caption"
          >
            {t("workspace.changed.discardCancel")}
          </Button>
        </>
      ) : (
        <>
          <Button
            variant="secondary"
            disabled={actionsBusy}
            onClick={() => void handleDiscardAll()}
            title={t("workspace.changed.discardAllHint")}
            aria-label={t("workspace.changed.discardAll")}
            className="md:min-h-0 md:px-2.5 md:py-1 text-caption"
          >
            {/* Icon and label need their own flex line: the facade puts both
                inside one content span, where the svg is a block and would
                stack above the text. */}
            <span className="inline-flex items-center gap-1.5">
              <IconX size={12} className="opacity-80" />
              {t("workspace.changed.discardAll")}
            </span>
          </Button>
          <Button
            variant="default"
            disabled={actionsBusy}
            onClick={() => void handleKeepAll()}
            title={t("workspace.changed.keepAllHint")}
            aria-label={t("workspace.changed.keepAll")}
            className="md:min-h-0 md:px-2.5 md:py-1 text-caption"
          >
            <span className="inline-flex items-center gap-1.5">
              <IconCheck size={12} />
              {t("workspace.changed.keepAll")}
            </span>
          </Button>
        </>
      )}
    </div>
  ) : null;

  if (isCard) {
    return (
      <div className={["rounded-xl bg-kin-elevated overflow-hidden", className ?? ""].join(" ")}>
        <div className="flex items-start gap-2 px-3 py-2 border-b border-[var(--kin-hairline)]">
          <Button
            variant="quiet"
            onClick={() => openDiffPanel()}
            title={t("workspace.changed.expand")}
            aria-label={`${t("workspace.changed.reviewTitle", { count: labelCount })} — ${t("workspace.changed.expand")}`}
            className="flex-1 min-w-0 flex-col items-stretch justify-start gap-0 rounded-md -mx-1 px-1 py-0.5 text-left"
          >
            <div className="flex items-center gap-1.5 min-w-0">
              <IconChevron size={12} className="flex-none text-kin-muted rotate-90" />
              <span className="text-caption font-semibold uppercase tracking-label text-kin-muted">
                {t("workspace.changed.cardTitle")}
              </span>
            </div>
            <div className="mt-0.5 flex items-center gap-2 min-w-0 pl-[18px]">
              <span className="text-body font-semibold text-kin-text truncate">
                {t("workspace.changed.reviewTitle", { count: labelCount })}
              </span>
              <span className="flex-none text-body font-mono tabular-nums">
                {stats.hasStats ? (
                  <DeltaInline additions={stats.additions} deletions={stats.deletions} />
                ) : (
                  <span className="font-sans text-caption text-kin-muted">
                    {t("workspace.changed.noLineDelta")}
                  </span>
                )}
              </span>
            </div>
            <div className="mt-0.5 pl-[18px] text-caption text-kin-muted">
              {t("workspace.changed.expand")}
            </div>
          </Button>
          {!showBulk && (
            <Button
              variant="quiet"
              onClick={() => setDismissed(true)}
              aria-label={t("workspace.changed.dismiss")}
              className="flex-none h-11 w-11 items-center justify-center p-0 text-kin-muted sm:h-6 sm:w-6"
            >
              <IconX size={13} />
            </Button>
          )}
        </div>

        <ul className="max-h-48 overflow-y-auto kin-scroll py-1">
          {preview.map((f) => {
            const name = fileBaseName(f.path);
            const dir = f.path.slice(0, Math.max(0, f.path.length - name.length));
            return (
              <li key={`${f.action}:${f.path}:${f.seq}`}>
                {/* eslint-disable-next-line kin/no-raw-button -- an option row in the list; the row is the hit area, not an action. */}
                <button
                  type="button"
                  onClick={() => openDiffPanel(f.path)}
                  className="w-full flex items-center gap-2 px-3 py-1.5 text-left hover:bg-[var(--kin-fill)] transition-colors"
                  title={f.path}
                >
                  <span className="min-w-0 flex-1">
                    <span className="block truncate text-body font-medium text-kin-text">
                      {name}
                    </span>
                    {dir ? (
                      <span className="block truncate text-caption font-mono text-kin-muted">
                        {dir}
                      </span>
                    ) : null}
                  </span>
                  <span className="flex-none text-caption font-mono tabular-nums">
                    <FileSize
                      additions={f.additions}
                      deletions={f.deletions}
                      label={t("workspace.changed.noLineDelta")}
                    />
                  </span>
                </button>
              </li>
            );
          })}
          {ordered.length > preview.length && (
            <li className="px-3 py-1.5 text-caption text-kin-muted">
              {t("workspace.changed.moreFiles", {
                count: ordered.length - preview.length,
              })}
            </li>
          )}
        </ul>

        {bulkActions && (
          <div className="px-3 py-2 border-t border-[var(--kin-hairline)]">{bulkActions}</div>
        )}
      </div>
    );
  }

  return (
    <div className={["flex-none", "bg-kin-elevated/60", className ?? ""].join(" ")}>
      <div className="px-4 sm:px-5 py-2 flex items-center gap-2 min-w-0">
        <Button
          variant="quiet"
          onClick={() => openDiffPanel()}
          title={t("workspace.changed.expand")}
          aria-label={`${t("workspace.changed.reviewTitle", { count: labelCount })} — ${t("workspace.changed.expand")}`}
          className="flex-1 min-w-0 flex items-center justify-start gap-2 text-left rounded-md -ml-1 pl-1 pr-1 py-0.5"
        >
          {/* The facade puts every child inside one content span, so the
              Button's own `gap` never lands between these pieces. The row
              needs its own flex line or the count and the diff delta run
              together. */}
          <span className="flex min-w-0 items-center gap-2">
            {/* Points right, not down: the row opens the workspace files/diff
                panel; a down chevron reads as an inline accordion on phone,
                where the expand hint is hidden. */}
            <IconChevron size={13} className="flex-none text-kin-muted" />
            <span className="flex-none text-body font-semibold text-kin-text">
              {t("workspace.changed.reviewTitle", { count: labelCount })}
            </span>
            <span className="flex-none text-body font-mono tabular-nums">
              {stats.hasStats ? (
                <DeltaInline additions={stats.additions} deletions={stats.deletions} />
              ) : (
                <span className="font-sans text-caption text-kin-muted">
                  {t("workspace.changed.noLineDelta")}
                </span>
              )}
            </span>
            <span className="hidden sm:inline flex-none text-caption text-kin-muted">
              {t("workspace.changed.expand")}
            </span>
          </span>
        </Button>

        {bulkActions}

        {!showBulk && (
          <Button
            variant="quiet"
            onClick={() => setDismissed(true)}
            aria-label={t("workspace.changed.dismiss")}
            className="flex-none h-11 w-11 items-center justify-center p-0 text-kin-muted sm:h-6 sm:w-6"
          >
            <IconX size={13} />
          </Button>
        )}
      </div>
    </div>
  );
}
