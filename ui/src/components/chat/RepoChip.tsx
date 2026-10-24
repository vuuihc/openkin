import { useT } from "../../i18n/react";
import { repoLink } from "../../lib/repo";

/**
 * The repository a session's work belongs to — when the Hub knows it.
 *
 * A session that runs on this machine takes its repository from its workspace
 * generation, and the pull-request panel is where that shows. A session that
 * runs on another machine has no generation here, so the Hub learns the
 * repository from that machine once, when the session starts, and keeps it on
 * the task row. This is where that answer is shown: on the same strip as the
 * directory and the branch, because together they are where the work is.
 *
 * Nothing is fetched and nothing is asked — the value is the row's own — and a
 * task with no recorded repository renders nothing at all.
 */
export default function RepoChip({
  repo,
  className,
}: {
  repo?: string | null;
  className?: string;
}) {
  const tr = useT();
  const link = repoLink(repo);
  if (!link) {
    return null;
  }
  const { label, href } = link;
  // The whole recorded name, for the tooltip: `owner/app` alone would not say
  // which host it is on.
  const repoName = (repo ?? "").trim();

  const body = (
    <>
      <RepoIcon />
      <span className="truncate font-mono">{label}</span>
    </>
  );
  const classes = [
    "flex-none inline-flex items-center gap-1 rounded-lg border border-[var(--kin-hairline-strong)]",
    "bg-[var(--kin-fill)] px-1.5 py-0.5 text-[11.5px] text-kin-secondary min-w-0",
    "max-w-[min(40vw,16rem)]",
    href ? "hover:border-kin-blue/40 hover:text-kin-blue" : "",
    className ?? "",
  ].join(" ");

  if (!href) {
    return (
      <span className={classes} title={tr("repo.recordedOn", { name: repoName })}>
        {body}
      </span>
    );
  }
  return (
    <a
      className={classes}
      href={href}
      target="_blank"
      rel="noreferrer noopener"
      title={tr("repo.openHint", { name: repoName })}
    >
      {body}
    </a>
  );
}

function RepoIcon() {
  return (
    <svg
      width="12"
      height="12"
      viewBox="0 0 24 24"
      fill="none"
      stroke="currentColor"
      strokeWidth="1.8"
      strokeLinecap="round"
      strokeLinejoin="round"
      className="flex-none opacity-80"
      aria-hidden
    >
      <path d="M4 19V5a2 2 0 0 1 2-2h12v18H6a2 2 0 0 1-2-2Z" />
      <path d="M8 3v18" />
    </svg>
  );
}
