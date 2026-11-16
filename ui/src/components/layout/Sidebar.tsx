import {
  useEffect,
  useRef,
  useState,
  type KeyboardEvent as ReactKeyboardEvent,
  type ReactNode,
} from "react";
import { Link, useLocation, useNavigate } from "react-router-dom";
import { type AgentInfo } from "../../api/client";
import { useT } from "../../i18n/react";
import { onGuardedLinkClick } from "../../lib/phoneNavigation";
import { IconArchive, IconDownload, IconInbox, IconPlus } from "../icons";
import SessionList from "../sessions/SessionList";

/**
 * The Mac list column: new chat, the conversation list, and the list's own
 * utilities.
 *
 * The brand and the four destinations are the area rail's job now
 * (`AreaNav`), so this column starts at the action that serves the list and
 * ends at the filters and imports that belong to it. The list is the shared
 * `SessionList`, the same component the phone page draws. Width decides the
 * column, not the feature set: search, filters, the project order, folds, pins
 * and row actions are one implementation, so the two surfaces cannot drift
 * apart again.
 *
 * The phone has no version of this column: since KIN-CONTINUE-002 the list page
 * itself is the phone's only navigation surface, and its footer carries the
 * destinations. A drawer here would be the second navigation surface that story
 * deleted.
 */
type Props = {
  selectedTaskId?: string | null;
  /** Highlight the draft / New chat entry. */
  draftActive?: boolean;
  /** Waiting approvals, shown on the Inbox destination so they are findable
   *  without opening the page. */
  pendingCount?: number;
  onNewChat: () => void;
  agentCatalog?: AgentInfo[];
  importingExternalSessions?: boolean;
  onImportExternalSessions?: (agents?: string[]) => void;
};

export default function Sidebar({
  selectedTaskId,
  draftActive,
  pendingCount = 0,
  onNewChat,
  agentCatalog = [],
  importingExternalSessions = false,
  onImportExternalSessions,
}: Props) {
  const tr = useT();
  const location = useLocation();
  const [importMenuOpen, setImportMenuOpen] = useState(false);
  const importMenuRef = useRef<HTMLDivElement>(null);
  const sessionProviders = agentCatalog.filter((agent) =>
    agent.capabilities?.includes("session_list"),
  );
  const archivedScope =
    location.pathname === "/sessions" &&
    new URLSearchParams(location.search).get("scope") === "archived";

  useEffect(() => {
    if (!importMenuOpen) return;
    const onDoc = (event: MouseEvent) => {
      if (!importMenuRef.current?.contains(event.target as Node)) setImportMenuOpen(false);
    };
    const onKey = (event: KeyboardEvent) => {
      if (event.key === "Escape") setImportMenuOpen(false);
    };
    document.addEventListener("mousedown", onDoc);
    document.addEventListener("keydown", onKey);
    return () => {
      document.removeEventListener("mousedown", onDoc);
      document.removeEventListener("keydown", onKey);
    };
  }, [importMenuOpen]);

  // Escape puts the disclosure away and hands focus back to the button that
  // opened it — the wrapper's first button, which is the trigger. Tab is how
  // the rows are reached; there is no arrow-key model to keep, because the
  // popup is a group of plain buttons rather than a menu.
  const onImportMenuKeyDown = (event: ReactKeyboardEvent<HTMLDivElement>) => {
    if (event.key !== "Escape") return;
    event.stopPropagation();
    setImportMenuOpen(false);
    importMenuRef.current?.querySelector<HTMLButtonElement>("button")?.focus();
  };

  const importMenuItems = (
    <>
      <button
        type="button"
        // An import that is already running cannot be started again — one
        // fan-out at a time, which is the hook's rule and not this menu's.
        disabled={importingExternalSessions}
        onClick={() => {
          setImportMenuOpen(false);
          onImportExternalSessions?.();
        }}
        className="w-full text-left px-3 py-2 text-body text-kin-text hover:bg-[var(--kin-fill-strong)] disabled:opacity-50"
      >
        {tr("nav.importAllAgents")}
      </button>
      <div className="my-1 border-t border-kin-hairline" />
      {sessionProviders.length > 0 ? (
        sessionProviders.map((provider) => (
          <button
            key={provider.id}
            type="button"
            disabled={importingExternalSessions}
            onClick={() => {
              setImportMenuOpen(false);
              onImportExternalSessions?.([provider.id]);
            }}
            className="w-full flex items-center gap-2 px-3 py-2 text-body text-kin-secondary hover:bg-[var(--kin-fill-strong)] hover:text-kin-text disabled:opacity-50"
          >
            <span className="w-1.5 h-1.5 rounded-full bg-kin-blue" />
            <span className="truncate">{provider.name || provider.id}</span>
            <span className="ml-auto text-micro text-kin-muted">{provider.id}</span>
          </button>
        ))
      ) : (
        <div className="px-3 py-2 text-caption text-kin-muted">{tr("nav.noSessionProviders")}</div>
      )}
    </>
  );

  // On a Mac the import entry lives with the list it serves. The area rail
  // owns the destinations; this row is the list's own foot — where its
  // attention queue (Inbox) and its archive filter sit, and where an import
  // starts. The phone's import lives in Agent Ops (KIN-CONTINUE-002), not here.
  const importIcon = onImportExternalSessions ? (
    <div className="relative" ref={importMenuRef}>
      <button
        type="button"
        disabled={importingExternalSessions}
        aria-expanded={importMenuOpen}
        aria-label={
          importingExternalSessions
            ? tr("nav.importingAgentSessions")
            : tr("nav.importAgentSessions")
        }
        title={
          importingExternalSessions
            ? tr("nav.importingAgentSessions")
            : tr("nav.importAgentSessions")
        }
        onClick={() => setImportMenuOpen((open) => !open)}
        className={[
          "flex h-8 w-full items-center justify-center gap-1.5 rounded-lg px-2 text-caption font-medium transition-colors",
          importMenuOpen
            ? "bg-[var(--kin-fill-strong)] text-kin-text"
            : "text-kin-muted hover:bg-[var(--kin-fill)] hover:text-kin-text",
          importingExternalSessions ? "opacity-50" : "",
        ].join(" ")}
      >
        <IconDownload size={14} className="flex-none" />
        <span className="truncate">
          {importingExternalSessions
            ? tr("nav.importingAgentSessions")
            : tr("nav.importAgentSessions")}
        </span>
      </button>
      {importMenuOpen && (
        <div
          role="group"
          aria-label={tr("nav.importAgentSessions")}
          onKeyDown={onImportMenuKeyDown}
          className="absolute bottom-full left-0 z-50 mb-1 w-60 rounded-lg bg-kin-elevated shadow-e3 py-1"
        >
          {importMenuItems}
        </div>
      )}
    </div>
  ) : null;

  // The prototype's column header: the list's name on the left, the action
  // that starts a chat on the right. The four areas are the rail's job, so
  // this names the column itself — the same word the rail gives the area, and
  // the one thing the 304px column is for.
  const newChatBlock = (
    <div className="flex items-center gap-2 px-3 pb-2 pt-3">
      <h2 className="min-w-0 flex-1 truncate text-subtitle font-semibold text-kin-text">
        {tr("nav.sessions")}
      </h2>
      <button
        type="button"
        // Not `onClick={onNewChat}`: the shell's entry point reads its first
        // argument as "already asked", and a click event would pass as truthy.
        onClick={() => onNewChat()}
        className={[
          "flex h-8 flex-none items-center gap-1.5 rounded-lg border px-2.5 text-caption font-medium transition-colors",
          draftActive
            ? "border-kin-blue/40 bg-kin-blue/15 text-kin-text"
            : "border-[var(--kin-hairline-strong)] bg-kin-fill text-kin-text hover:bg-[var(--kin-fill-strong)]",
        ].join(" ")}
      >
        <IconPlus size={14} strokeWidth={1.9} className="flex-none" />
        {tr("nav.newChat")}
        <span className="text-micro font-medium text-kin-muted">⌘N</span>
      </button>
    </div>
  );

  // The archive is a filter of the one list (`?scope=archived`), not a second
  // list in the main area. The link is always present: an empty archive still
  // has a view that says so, and a control that appears only after the first
  // archive is a destination people never learn.
  //
  // Inbox stays here rather than moving to the rail: it is the list's own
  // attention queue, not one of the four areas, and its count is the number of
  // conversations in this list that wait on a person.
  //
  // Every entry is labelled and the two halves share the column's width: three
  // unlabelled icons bunched at the left of 304px read as decoration and left
  // the rest of the bar empty (S1 review).
  const listFooter = (
    <div data-sidebar-footer className="border-t border-kin-hairline px-2 py-2">
      <div className="grid grid-cols-2 gap-1">
        <FooterIcon
          to="/inbox"
          label={tr("nav.inbox")}
          icon={<IconInbox size={15} />}
          active={location.pathname === "/inbox"}
          badge={pendingCount > 0 ? (pendingCount > 99 ? "99+" : String(pendingCount)) : undefined}
        />
        <FooterIcon
          to="/sessions?scope=archived"
          label={tr("nav.archivedProjects")}
          icon={<IconArchive size={15} />}
          active={archivedScope}
        />
      </div>
      {importIcon ? <div className="mt-1">{importIcon}</div> : null}
    </div>
  );

  return (
    <div className="hidden md:flex h-full shrink-0 kin-zen-hide">
      <aside className="w-list h-full flex flex-col bg-kin-sidebar shrink-0">
        {newChatBlock}
        <SessionList shell="sidebar" activeTaskId={selectedTaskId ?? null} />
        {listFooter}
      </aside>
    </div>
  );
}

function FooterIcon({
  to,
  label,
  icon,
  badge,
  active = false,
}: {
  to: string;
  label: string;
  icon: ReactNode;
  badge?: string;
  /** A filter of this list (`?scope=archived`) is not a path `NavLink` can
   *  tell apart, so the current view is passed in rather than inferred. */
  active?: boolean;
}) {
  const tr = useT();
  const navigate = useNavigate();
  const location = useLocation();
  return (
    <Link
      to={to}
      onClick={(event) => onGuardedLinkClick(event, navigate, location, to)}
      // The badge is a number next to an icon; a name that leaves it out tells
      // a screen reader there is nothing waiting when the dot says otherwise.
      aria-label={badge ? tr("nav.withCount", { label, count: badge }) : label}
      aria-current={active ? "page" : undefined}
      title={label}
      className={[
        "flex h-8 min-w-0 items-center justify-center gap-1.5 rounded-lg px-2 text-caption font-medium transition-colors",
        active
          ? "bg-[var(--kin-fill-strong)] text-kin-text"
          : "text-kin-muted hover:bg-[var(--kin-fill)] hover:text-kin-text",
      ].join(" ")}
    >
      <span className="flex-none">{icon}</span>
      <span className="truncate">{label}</span>
      {badge ? (
        <span className="inline-flex h-[17px] min-w-[17px] flex-none items-center justify-center rounded-full bg-kin-orange px-1 text-micro font-bold tabular-nums text-kin-on-status">
          {badge}
        </span>
      ) : null}
    </Link>
  );
}
