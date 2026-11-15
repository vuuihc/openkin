/* eslint-disable kin/no-raw-button -- markup moved unchanged from ProjectDetailPage; new controls should use a shared primitive. */
import { useEffect, useId } from "react";
import { Link, useLocation, useNavigate } from "react-router-dom";
import type { Project, ProjectMode } from "../../api/client";
import { IconBack } from "../icons";
import SearchSelect from "../ui/SearchSelect";
import { SkeletonLine } from "../Skeleton";
import { draftEntryState, onGuardedLinkClick, returnListUrl } from "../../lib/phoneNavigation";
import { formatRelativeTime } from "../../lib/relativeTime";
import { useT } from "../../i18n/react";

/**
 * The top of the project cover: which project this is, which folder it lives
 * in, what mode it is running in, and how stale the screen is offline.
 *
 * The cover, not each control, owns Escape and ⌘Enter (KIN-PROJECT-001 step
 * 6): leaving and starting the next chat are cover-level actions, and a reader
 * should not have to focus a particular button first. Typing fields, open
 * pickers and an active summary edit keep their own keys. The page mounts this
 * headless on its loading and error screens so those keys stay bound.
 */
type Props = {
  /** The project record, cached or fresh. `null` paints the loading state. */
  project: Project | null;
  root?: string;
  loading?: boolean;
  offline?: boolean;
  lastLoadedAt?: number;
  now: number;
  /** A summary edit owns Escape while it is open. */
  editing?: boolean;
  /** ⌘Enter is only a chat when there is somewhere to go. */
  canStartChat: boolean;
  onBack: () => void;
  onModeChange: (mode: ProjectMode) => void;
  onStartChat: () => void;
};

export default function ProjectCover({
  project,
  root = "",
  loading = false,
  offline = false,
  lastLoadedAt = 0,
  now,
  editing = false,
  canStartChat,
  onBack,
  onModeChange,
  onStartChat,
}: Props) {
  const tr = useT();

  useEffect(() => {
    const onKeyDown = (event: globalThis.KeyboardEvent) => {
      const target = event.target instanceof HTMLElement ? event.target : null;
      const typing = Boolean(
        target &&
        (target.tagName === "INPUT" ||
          target.tagName === "TEXTAREA" ||
          target.tagName === "SELECT" ||
          target.isContentEditable),
      );
      if (event.key === "Escape") {
        if (editing || typing) return;
        // A picker or sheet owns Escape while it is open; leaving the project
        // because the reader closed a menu is not the same key press.
        if (document.querySelector('[role="listbox"], [role="dialog"]')) return;
        event.preventDefault();
        onBack();
        return;
      }
      if ((event.metaKey || event.ctrlKey) && event.key === "Enter") {
        if (editing || typing || !canStartChat) return;
        event.preventDefault();
        onStartChat();
      }
    };
    window.addEventListener("keydown", onKeyDown);
    return () => window.removeEventListener("keydown", onKeyDown);
  }, [canStartChat, editing, onBack, onStartChat]);

  if (!project) {
    // Headless mount: the page keeps the keys bound where no cover is painted.
    if (!loading) return null;
    return (
      <div
        data-testid="project-cover-loading"
        aria-busy={loading || undefined}
        className="mb-4 space-y-3"
      >
        {loading && (
          <>
            <SkeletonLine />
            <SkeletonLine />
          </>
        )}
      </div>
    );
  }

  return (
    <header>
      <button
        type="button"
        className="mb-3 inline-flex items-center gap-1 text-strong text-kin-secondary hover:text-kin-text"
        onClick={onBack}
      >
        <IconBack size={14} />
        {tr("projects.back")}
      </button>
      <div className="mb-4 flex flex-wrap items-start justify-between gap-2">
        <div className="min-w-0">
          <h1 tabIndex={0} className="truncate text-title leading-7 font-semibold text-kin-text">
            {project.name}
          </h1>
          {root && (
            <div className="mt-1 max-w-sheet truncate text-body text-kin-secondary">{root}</div>
          )}
        </div>
        <SearchSelect
          label={tr("projects.mode")}
          value={project.mode}
          options={[
            { id: "ship", label: tr("projects.modeShip") },
            { id: "learn", label: tr("projects.modeLearn") },
            { id: "explore", label: tr("projects.modeExplore") },
            { id: "maintain", label: tr("projects.modeMaintain") },
          ]}
          onChange={(next) => onModeChange(next as ProjectMode)}
          disabled={offline}
          className="text-body text-kin-text"
        />
      </div>
      {offline && lastLoadedAt > 0 && (
        <div
          role="status"
          className="mb-3 rounded-lg border border-kin-hairline bg-kin-panel px-3 py-2 text-body text-kin-secondary"
        >
          {tr("projects.offlineSince", { time: formatRelativeTime(lastLoadedAt, now) })}
        </div>
      )}
    </header>
  );
}

/** The cover's continue affordance: start a chat in the project's root. */
export function NewChatControl({
  href,
  disabledReason,
  fullWidth,
}: {
  href: string | null;
  disabledReason: string;
  fullWidth: boolean;
}) {
  const tr = useT();
  const navigate = useNavigate();
  const location = useLocation();
  const reasonId = useId();
  const className = [
    "inline-flex min-h-11 items-center justify-center rounded-lg bg-kin-blue px-3 text-strong font-medium text-kin-on-brand",
    fullWidth ? "w-full" : "",
  ].join(" ");

  if (href === null || disabledReason) {
    return (
      <div className={fullWidth ? "w-full" : ""}>
        <button
          type="button"
          disabled
          aria-describedby={disabledReason ? reasonId : undefined}
          className={`${className} opacity-50`}
        >
          {tr("projects.newChat")}
        </button>
        {disabledReason && (
          <p id={reasonId} className="mt-1 text-caption text-kin-muted">
            {disabledReason}
          </p>
        )}
      </div>
    );
  }

  return (
    <Link
      to={href}
      className={className}
      onClick={(event) =>
        onGuardedLinkClick(event, navigate, location, href, {
          state: draftEntryState(returnListUrl(location)),
        })
      }
    >
      {tr("projects.newChat")}
    </Link>
  );
}
