import { useState } from "react";
import { shortPath } from "../../lib/paths";
import { evidenceFilePreview, type RoundEvidence } from "../../lib/roundEvidence";
import { useT } from "../../i18n/react";
import DeltaInline, { actionDotClass, actionLabelKey } from "../changedFileFace";
import PreviewLines from "../PreviewLines";
import { IconChevron, IconFile } from "../icons";

/**
 * What one round changed, drawn under the work it is an answer to.
 *
 * The scope sentence at the bottom is not decoration and is not behind the fold:
 * this card counts what the agent changed *through file tools*, so an agent that
 * rewrote a file with `sed` leaves nothing here, and a reader who took this list
 * for the workspace diff would conclude the opposite of the truth. The workspace
 * and PR panels remain the authority, and the card says so where it is read.
 *
 * The diff behind each file is reconstructed from the tool payload rather than
 * read back from disk (see `diffPreview.ts`), which is the other reason the card
 * points at the panel: it shows the change the agent reported making.
 */
export default function RoundEvidenceCard({
  evidence,
  onOpenPath,
}: {
  evidence: RoundEvidence;
  onOpenPath?: (path: string) => void;
}) {
  const tr = useT();
  // Open on the file list: the question this card answers is answered by the
  // list, and a phone should not have to tap to see it. The diffs are the tap.
  const [open, setOpen] = useState(true);
  const [openPath, setOpenPath] = useState<string | null>(null);
  const hiddenFiles = Math.max(0, evidence.totalFiles - evidence.files.length);

  return (
    <div className="rounded-xl border border-[var(--kin-hairline)] bg-[var(--kin-fill)] overflow-hidden">
      <button
        type="button"
        onClick={() => setOpen((value) => !value)}
        aria-expanded={open}
        className="flex w-full items-center gap-2 px-3 py-2 text-left text-body hover:bg-[var(--kin-fill-strong)] transition-colors"
      >
        <IconFile size={14} className="flex-none text-kin-muted" />
        <span className="min-w-0 flex-1 truncate font-medium text-kin-text">
          {tr("chat.evidence.title")}
        </span>
        <span className="flex-none text-caption tabular-nums text-kin-muted">
          {tr("chat.evidence.files", { count: evidence.totalFiles })}
        </span>
        {evidence.hasStats && (
          <span className="flex-none text-caption tabular-nums">
            <DeltaInline additions={evidence.additions} deletions={evidence.deletions} />
          </span>
        )}
        <span className="flex-none text-caption text-kin-muted">
          {open ? tr("chat.progress.hide") : tr("chat.progress.details")}
        </span>
      </button>

      {open && (
        <div className="border-t border-[var(--kin-hairline)] divide-y divide-[var(--kin-hairline)]">
          {evidence.files.map((file) => {
            const expanded = openPath === file.path;
            // Read on demand: one file's payload is rebuilt when it is opened,
            // not six when the card is drawn.
            const preview = expanded ? evidenceFilePreview(evidence, file.path) : null;
            const known = file.additions != null || file.deletions != null;
            return (
              <div key={`${file.action}:${file.path}`}>
                <button
                  type="button"
                  onClick={() => setOpenPath(expanded ? null : file.path)}
                  aria-expanded={expanded}
                  title={file.path}
                  className="flex w-full items-center gap-2 px-3 py-1.5 text-left hover:bg-kin-elevated/30 transition-colors"
                >
                  <span
                    aria-hidden="true"
                    className={`h-1.5 w-1.5 flex-none rounded-full ${actionDotClass(file.action)}`}
                  />
                  <span className="min-w-0 flex-1 truncate font-mono text-caption text-kin-secondary">
                    {shortPath(file.path, 40)}
                  </span>
                  <span className="flex-none text-micro uppercase tracking-label text-kin-muted">
                    {tr(actionLabelKey(file.action))}
                  </span>
                  <span className="flex-none text-caption tabular-nums">
                    {known ? (
                      <DeltaInline
                        additions={file.additions ?? 0}
                        deletions={file.deletions ?? 0}
                      />
                    ) : (
                      <span className="text-kin-muted">{tr("workspace.changed.noLineDelta")}</span>
                    )}
                  </span>
                  <IconChevron
                    size={12}
                    className={`flex-none text-kin-muted ${expanded ? "rotate-90" : ""}`}
                  />
                </button>

                {expanded && (
                  <div className="space-y-1.5 px-3 pb-2 pl-6">
                    {preview ? (
                      <PreviewLines lines={preview.lines} />
                    ) : (
                      // A delete, or a payload with no body to reconstruct. The
                      // row is still a change; it just has nothing to show.
                      <p className="text-caption text-kin-muted">{tr("chat.evidence.noPreview")}</p>
                    )}
                    {preview && preview.hidden > 0 && (
                      <p className="text-caption text-kin-muted">
                        {tr("chat.diff.truncated", { count: preview.hidden })}
                      </p>
                    )}
                    {onOpenPath && (
                      <button
                        type="button"
                        onClick={() => onOpenPath(file.path)}
                        className="font-mono text-caption text-kin-blue-ink hover:underline"
                        title={file.path}
                      >
                        {tr("workspace.openFile")} · {shortPath(file.path, 48)}
                      </button>
                    )}
                  </div>
                )}
              </div>
            );
          })}
          {hiddenFiles > 0 && (
            <p className="px-3 py-1.5 text-caption text-kin-muted">
              {tr("chat.evidence.moreFiles", { count: hiddenFiles })}
            </p>
          )}
        </div>
      )}

      <p className="border-t border-[var(--kin-hairline)] px-3 py-1.5 text-micro text-kin-muted">
        {tr("chat.evidence.scope")}
      </p>
    </div>
  );
}
