import type { MouseEvent } from "react";
import { useId } from "react";
import { Link } from "react-router-dom";
import { useT } from "../../i18n/react";
import { projectInstructions } from "../../lib/projectInstructions";
import { SkeletonLine } from "../Skeleton";
import Button from "../ui/Button";
import InlineAlert from "../ui/InlineAlert";

/**
 * "How to work here" on the project cover (KIN-PROJECT-003).
 *
 * Read-only on purpose: the text lives in ONE_PAGER.md, a new chat receives it,
 * and changing it happens in a chat or in the file. The block therefore shows
 * exactly what the digest would carry — including the 400-character cut and the
 * "last known" mark offline — and offers one action, a launcher that pre-fills a
 * new chat with a request to edit the section. It never saves and never starts a
 * task.
 */
type Props = {
  titleId: string;
  loaded: boolean;
  loading: boolean;
  loadError: string | null;
  markdown: string;
  offline: boolean;
  /** The new-chat draft with the edit prompt pre-filled, or null when disabled. */
  launcherHref: string | null;
  /** Label for the non-empty state ("Ask Kin to edit…"). */
  launcherLabel: string;
  /** Why the launcher is disabled; empty when it is usable. */
  launcherReason: string;
  onLauncherClick: (event: MouseEvent<HTMLAnchorElement>) => void;
  onRetry: () => void;
};

export default function ProjectInstructionsBlock({
  titleId,
  loaded,
  loading,
  loadError,
  markdown,
  offline,
  launcherHref,
  launcherLabel,
  launcherReason,
  onLauncherClick,
  onRetry,
}: Props) {
  const tr = useT();
  const reasonId = useId();
  const { text, truncated } = projectInstructions(markdown);
  const disabled = offline || launcherHref === null || Boolean(launcherReason);
  const label = text ? launcherLabel : tr("projects.instructionsWrite");
  const footnote = !text
    ? tr("projects.instructionsNotSent")
    : truncated
      ? tr("projects.instructionsTruncated")
      : tr("projects.instructionsFootnote");

  return (
    <section aria-labelledby={titleId} className="rounded-xl bg-kin-panel p-4">
      <div className="mb-2 flex flex-wrap items-center justify-between gap-2">
        <h2
          id={titleId}
          className="text-body font-medium uppercase tracking-label text-kin-secondary"
        >
          {tr("projects.instructionsTitle")}
        </h2>
        {loaded && !loadError ? (
          disabled ? (
            <Button
              variant="secondary"
              disabled
              aria-describedby={launcherReason ? reasonId : undefined}
              className="min-h-11 text-strong"
            >
              {label}
            </Button>
          ) : (
            <Link
              to={launcherHref}
              onClick={onLauncherClick}
              className="inline-flex min-h-11 items-center gap-1 text-body text-kin-secondary hover:text-kin-text"
            >
              {label}
              <span aria-hidden>→</span>
            </Link>
          )
        ) : null}
      </div>

      {loadError ? (
        <InlineAlert>
          <p>{loadError}</p>
          <Button variant="secondary" onClick={onRetry} className="mt-2 text-strong">
            {tr("common.retry")}
          </Button>
        </InlineAlert>
      ) : !loaded ? (
        loading ? (
          <div className="space-y-3 py-2">
            <SkeletonLine />
            <SkeletonLine />
          </div>
        ) : null
      ) : (
        <>
          <p className="mb-2 text-caption text-kin-muted">{tr("projects.instructionsLead")}</p>
          {text ? (
            <p className="whitespace-pre-wrap text-body leading-prose text-kin-text">{text}</p>
          ) : (
            <p className="text-body text-kin-secondary">{tr("projects.instructionsEmpty")}</p>
          )}
          <p className="mt-2 text-caption text-kin-muted">
            {offline && <span>{tr("projects.instructionsOffline")} · </span>}
            {footnote}
          </p>
          {disabled && launcherReason && (
            // The cover already explains the disabled state where the same
            // reason applies to "New chat"; repeating it visibly would say the
            // same sentence twice. The launcher still names its own reason to
            // assistive tech through the description.
            <p id={reasonId} className="sr-only">
              {label}: {launcherReason}
            </p>
          )}
        </>
      )}
    </section>
  );
}
