import { useState } from "react";
import { shortPath } from "../../lib/paths";
import { evidenceFilePreview, type RoundEvidence } from "../../lib/roundEvidence";
import { useT } from "../../i18n/react";
import { FileSize, actionDotClass, actionLabelKey } from "../changedFileFace";
import PreviewLines from "../PreviewLines";
import { IconChevron, IconFile } from "../icons";
import Button from "../ui/Button";

/**
 * What one round changed, drawn under the work it is an answer to.
 *
 * The scope sentence at the bottom is not decoration and is not behind the fold:
 * it says what the list is and is not. A round the daemon recorded was compared
 * between two workspace snapshots, so shell commands are in it; a round
 * reconstructed from the stream counts what the agent changed *through file
 * tools*, so an agent that rewrote a file with `sed` leaves nothing there. A
 * reader who took either one for the workspace diff would conclude the opposite
 * of the truth in some case, and the workspace and PR panels remain the
 * authority.
 *
 * The diff behind each file is reconstructed from the tool payload rather than
 * read back from disk (see `diffPreview.ts`), which is why a file the record
 * found but no tool reported shows "nothing reconstructible" when opened: the
 * card shows the change, not its contents.
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
      {/* The whole header is the disclosure on the console's facade; the row's
          own geometry stays on the content span, where Astryx puts the button's
          children, so the facade's focus ring and phone floor surround it. */}
      <Button
        variant="quiet"
        onClick={() => setOpen((value) => !value)}
        aria-expanded={open}
        className="flex w-full justify-start rounded-sm p-0 text-left text-body font-normal hover:bg-transparent"
      >
        <span className="flex w-full items-center gap-2 px-3 py-2 transition-colors hover:bg-[var(--kin-fill-strong)]">
          <IconFile size={14} className="flex-none text-kin-muted" />
          <span className="min-w-0 flex-1 truncate font-medium text-kin-text">
            {tr("chat.evidence.title")}
          </span>
          <span className="flex-none text-caption tabular-nums text-kin-muted">
            {tr("chat.evidence.files", { count: evidence.totalFiles })}
          </span>
          {/* The same face the rows below use, from the same component: a round whose
              payloads carried no counts says "size unknown" here too, rather than
              going quiet in the header while its own rows say it. */}
          <span className="flex-none text-caption tabular-nums">
            <FileSize
              additions={evidence.hasStats ? evidence.additions : null}
              deletions={evidence.hasStats ? evidence.deletions : null}
              label={tr("workspace.changed.noLineDelta")}
            />
          </span>
          <span className="flex-none text-caption text-kin-muted">
            {open ? tr("chat.progress.hide") : tr("chat.progress.details")}
          </span>
        </span>
      </Button>

      {open && (
        <div className="border-t border-[var(--kin-hairline)] divide-y divide-[var(--kin-hairline)]">
          {evidence.files.map((file) => {
            const expanded = openPath === file.path;
            // Read on demand: one file's payload is rebuilt when it is opened,
            // not six when the card is drawn.
            const preview = expanded ? evidenceFilePreview(evidence, file.path) : null;
            return (
              <div key={`${file.action}:${file.path}`}>
                <Button
                  variant="quiet"
                  onClick={() => setOpenPath(expanded ? null : file.path)}
                  aria-expanded={expanded}
                  title={file.path}
                  className="flex w-full justify-start rounded-sm p-0 text-left font-normal hover:bg-transparent"
                >
                  <span className="flex w-full items-center gap-2 px-3 py-1.5 transition-colors hover:bg-kin-elevated/30">
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
                      <FileSize
                        additions={file.additions}
                        deletions={file.deletions}
                        label={tr("workspace.changed.noLineDelta")}
                      />
                    </span>
                    <IconChevron
                      size={12}
                      className={`flex-none text-kin-muted ${expanded ? "rotate-90" : ""}`}
                    />
                  </span>
                </Button>

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
                        {/* lines.length, not hidden: what is drawn above is what the
                            caption is talking about. hidden is the count that did not
                            fit, and the two differ by the whole preview. */}
                        {tr("chat.diff.truncated", { count: preview.lines.length })}
                      </p>
                    )}
                    {onOpenPath && (
                      <Button
                        variant="quiet"
                        onClick={() => onOpenPath(file.path)}
                        className="rounded-md p-0 font-mono text-caption font-normal hover:bg-transparent hover:underline"
                        title={file.path}
                      >
                        <span className="text-kin-blue-ink">
                          {tr("workspace.openFile")} · {shortPath(file.path, 48)}
                        </span>
                      </Button>
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
        {tr(
          evidence.source === "workspace" ? "chat.evidence.scopeWorkspace" : "chat.evidence.scope",
        )}
      </p>
    </div>
  );
}
