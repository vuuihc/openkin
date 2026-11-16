import {
  useEffect,
  useRef,
  useState,
  type KeyboardEvent as ReactKeyboardEvent,
  type ReactNode,
} from "react";
import { Link, NavLink, useLocation, useNavigate } from "react-router-dom";
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
  const navigate = useNavigate();
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
          "relative inline-flex h-8 w-8 flex-none items-center justify-center rounded-lg transition-colors",
          importMenuOpen
            ? "bg-[var(--kin-fill-strong)] text-kin-text"
            : "text-kin-muted hover:bg-[var(--kin-fill)] hover:text-kin-text",
          importingExternalSessions ? "opacity-50" : "",
        ].join(" ")}
      >
        <IconDownload size={16} />
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

  const newChatBlock = (
    <div className="px-2.5 pb-2">
      <button
        type="button"
        // Not `onClick={onNewChat}`: the shell's entry point reads its first
        // argument as "already asked", and a click event would pass as truthy.
        onClick={() => onNewChat()}
        className={[
          "w-full flex items-center gap-2 px-2.5 h-9 rounded-lg text-strong font-medium border transition-colors",
          draftActive
            ? "border-kin-blue/40 bg-kin-blue/15 text-kin-text"
            : "border-[var(--kin-hairline-strong)] bg-kin-fill text-kin-text hover:bg-[var(--kin-fill-strong)]",
        ].join(" ")}
      >
        <IconPlus size={15} strokeWidth={1.9} />
        {tr("nav.newChat")}
        <span className="ml-auto text-caption text-kin-muted font-medium hidden sm:inline">⌘N</span>
      </button>
    </div>
  );

  // The archive is a filter of the one list (`?scope=archived`), not a second
  // list in the main area. The icon is always present: an empty archive still
  // has a view that says so, and a control that appears only after the first
  // archive is a destination people never learn.
  //
  // Inbox stays here rather than moving to the rail: it is the list's own
  // attention queue, not one of the four areas, and its count is the number of
  // conversations in this list that wait on a person.
  const listFooter = (
    <div data-sidebar-footer className="border-t border-kin-hairline px-1.5 py-2">
      <div className="flex items-center gap-1">
        <FooterIcon
          to="/inbox"
          label={tr("nav.inbox")}
          icon={<IconInbox size={16} />}
          badge={pendingCount > 0 ? (pendingCount > 99 ? "99+" : String(pendingCount)) : undefined}
        />
        <Link
          to="/sessions?scope=archived"
          onClick={(event) =>
            onGuardedLinkClick(event, navigate, location, "/sessions?scope=archived")
          }
          aria-label={tr("nav.archivedProjects")}
          aria-current={archivedScope ? "page" : undefined}
          title={tr("nav.archivedProjects")}
          className={[
            "inline-flex h-8 w-8 flex-none items-center justify-center rounded-lg transition-colors",
            archivedScope
              ? "bg-[var(--kin-fill-strong)] text-kin-text"
              : "text-kin-muted hover:bg-[var(--kin-fill)] hover:text-kin-text",
          ].join(" ")}
        >
          <IconArchive size={16} />
        </Link>
        {importIcon}
      </div>
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
  title,
}: {
  to: string;
  label: string;
  icon: ReactNode;
  badge?: string;
  title?: string;
}) {
  const tr = useT();
  const navigate = useNavigate();
  const location = useLocation();
  return (
    <NavLink
      to={to}
      onClick={(event) => onGuardedLinkClick(event, navigate, location, to)}
      // The badge is a number next to an icon; a name that leaves it out tells
      // a screen reader there is nothing waiting when the dot says otherwise.
      aria-label={badge ? tr("nav.withCount", { label, count: badge }) : label}
      title={title ?? label}
      className={({ isActive }) =>
        [
          "relative inline-flex h-8 w-8 flex-none items-center justify-center rounded-lg transition-colors",
          isActive
            ? "bg-[var(--kin-fill-strong)] text-kin-text"
            : "text-kin-muted hover:bg-[var(--kin-fill)] hover:text-kin-text",
        ].join(" ")
      }
    >
      {icon}
      {badge ? (
        <span className="absolute -right-0.5 -top-0.5 min-w-[15px] h-[15px] px-0.5 rounded-full bg-kin-orange text-kin-on-status text-micro font-bold inline-flex items-center justify-center tabular-nums">
          {badge}
        </span>
      ) : null}
    </NavLink>
  );
}
