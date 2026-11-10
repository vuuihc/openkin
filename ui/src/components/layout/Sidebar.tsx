import {
  useEffect,
  useRef,
  useState,
  type KeyboardEvent as ReactKeyboardEvent,
  type ReactNode,
} from "react";
import { Link, NavLink, useLocation } from "react-router-dom";
import { formatCost, type AgentInfo } from "../../api/client";
import { useT } from "../../i18n/react";
import { useMinWidth } from "../../hooks/useMinWidth";
import { useDrawerSwipe } from "../../hooks/useDrawerSwipe";
import { placeById, PLACES, type PlaceId } from "../../lib/places";
import { PLACE_ICONS } from "../placeIcons";
import { IconArchive, IconChevron, IconDownload, IconPlus, IconX } from "../icons";
import SessionList from "../sessions/SessionList";

/**
 * The Mac sidebar: identity, new chat, the conversation list, and the way out.
 *
 * The list is the shared `SessionList`, the same component the phone page
 * draws. Width decides the column, not the feature set: search, filters, the
 * project order, folds, pins and row actions are one implementation, so the
 * two surfaces cannot drift apart again. What stays here is the chrome around
 * the list — the brand header, the import menu, the footer's destinations, and
 * the phone drawer (which is entries only: a list there was a second copy of
 * the page one tap away).
 */
type Props = {
  selectedTaskId?: string | null;
  /** Highlight the draft / New chat entry. */
  draftActive?: boolean;
  routineUnreadCount?: number;
  weekCost?: number | null;
  onNewChat: () => void;
  agentCatalog?: AgentInfo[];
  importingExternalSessions?: boolean;
  onImportExternalSessions?: (agents?: string[]) => void;
  /** Mobile drawer open. Desktop always visible. */
  mobileOpen: boolean;
  onOpenMobile: () => void;
  onCloseMobile: () => void;
};

export default function Sidebar({
  selectedTaskId,
  draftActive,
  routineUnreadCount = 0,
  weekCost,
  onNewChat,
  agentCatalog = [],
  importingExternalSessions = false,
  onImportExternalSessions,
  mobileOpen,
  onOpenMobile,
  onCloseMobile,
}: Props) {
  const tr = useT();
  const location = useLocation();
  // One tree, one width: a phone has no sidebar to hold the list, and the
  // drawer is entries only. Rendering both copies and hiding one with CSS left
  // the other's search field in the document, which is how the same list grew
  // two search boxes.
  const wide = useMinWidth(768);
  const drawerSwipe = useDrawerSwipe(mobileOpen, (open) =>
    open ? onOpenMobile() : onCloseMobile(),
  );
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
  // opened it — the wrapper's first button, which is the trigger in both
  // surfaces. Tab is how the rows are reached; there is no arrow-key model to
  // keep, because the popup is a group of plain buttons rather than a menu.
  const onImportMenuKeyDown = (event: ReactKeyboardEvent<HTMLDivElement>) => {
    if (event.key !== "Escape") return;
    event.stopPropagation();
    setImportMenuOpen(false);
    importMenuRef.current?.querySelector<HTMLButtonElement>("button")?.focus();
  };

  // The import entry's menu, shared by the drawer's full-width button and the
  // desktop footer's icon. One list, so the two surfaces cannot offer different
  // imports.
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

  const header = (drawer: boolean) => (
    <div className="px-3 pt-3 pb-2 max-md:px-3 max-md:pt-4 max-md:pb-3 flex items-center gap-2">
      <div className="w-7 h-7 max-md:h-8 max-md:w-8 rounded-lg bg-kin-blue flex items-center justify-center text-kin-on-brand text-strong font-semibold shadow-e1">
        K
      </div>
      <span className="text-strong max-md:text-subtitle font-semibold tracking-tight">
        {tr("app.name")}
      </span>
      <div className="ml-auto flex items-center gap-1">
        {drawer && (
          // The drawer's own dismissal. The scrim still closes it, but a
          // full-height panel that covers 86% of the screen leaves almost no
          // scrim to hit — the close control is the reliable way out.
          <button
            type="button"
            onClick={onCloseMobile}
            aria-label={tr("app.closeMenu")}
            title={tr("app.closeMenu")}
            className="inline-flex h-11 w-11 -mr-2 items-center justify-center rounded-full text-kin-muted active:bg-[var(--kin-fill)]"
          >
            <IconX size={22} />
          </button>
        )}
      </div>
    </div>
  );

  const importBlock = (
    <div className="px-3 pb-2 relative" ref={importMenuRef}>
      <button
        type="button"
        disabled={importingExternalSessions || !onImportExternalSessions}
        aria-expanded={importMenuOpen}
        onClick={() => setImportMenuOpen((open) => !open)}
        className="w-full flex items-center gap-2 px-2.5 h-11 rounded-xl text-strong text-kin-secondary border border-[var(--kin-hairline-strong)] hover:bg-[var(--kin-fill-strong)] hover:text-kin-text disabled:opacity-50 transition-colors"
      >
        <IconDownload size={16} />
        <span className="flex-1 text-left">
          {importingExternalSessions
            ? tr("nav.importingAgentSessions")
            : tr("nav.importAgentSessions")}
        </span>
        <IconChevron
          size={13}
          className={importMenuOpen ? "rotate-90 transition-transform" : "transition-transform"}
        />
      </button>
      {importMenuOpen && (
        <div
          // A disclosure, not a menu: the rows are plain buttons reached by
          // Tab. Calling it a menu promises arrow-key navigation that this
          // popup does not implement.
          role="group"
          aria-label={tr("nav.importAgentSessions")}
          onKeyDown={onImportMenuKeyDown}
          className="absolute left-3 right-3 top-full mt-1 z-50 rounded-lg bg-kin-elevated shadow-e3 py-1"
        >
          {importMenuItems}
        </div>
      )}
    </div>
  );

  // On a Mac the same entry is one of the footer icons: the left column is one
  // piece — the list, then one row of destinations — and a full-width import
  // button above it was a second navigation block with the same weight as the
  // list it was supposed to serve.
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
    <div className="px-2.5 pb-2 max-md:px-3">
      <button
        type="button"
        onClick={() => {
          onNewChat();
          onCloseMobile();
        }}
        className={[
          "w-full flex items-center gap-2 px-2.5 h-9 max-md:h-11 max-md:rounded-xl max-md:font-semibold rounded-lg text-strong font-medium border transition-colors",
          "max-md:border-transparent max-md:bg-kin-blue max-md:text-kin-on-brand max-md:active:opacity-90",
          draftActive
            ? "border-kin-blue/40 bg-kin-blue/15 text-kin-text"
            : "border-[var(--kin-hairline-strong)] bg-kin-fill text-kin-text hover:bg-[var(--kin-fill-strong)]",
        ].join(" ")}
      >
        <IconPlus size={15} strokeWidth={1.9} className="max-md:h-[18px] max-md:w-[18px]" />
        {tr("nav.newChat")}
        <span className="ml-auto text-caption text-kin-muted font-medium hidden sm:inline">⌘N</span>
      </button>
    </div>
  );

  // The archive is a filter of the one list (`?scope=archived`), not a second
  // list in the main area. The icon is always present: an empty archive still
  // has a view that says so, and a control that appears only after the first
  // archive is a destination people never learn.
  const footerIcons = (
    <div data-sidebar-footer className="border-t border-kin-hairline px-1.5 py-2">
      <div className="flex items-center justify-between gap-0.5">
        <Link
          to="/sessions?scope=archived"
          aria-label={tr("nav.archivedProjects")}
          aria-current={archivedScope ? "page" : undefined}
          title={tr("nav.archivedProjects")}
          onClick={onCloseMobile}
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
        {PLACES.filter((place) => place.section !== "work").map((place) => {
          const Icon = PLACE_ICONS[place.id];
          return (
            <FooterIcon
              key={place.id}
              to={place.path}
              label={tr(place.labelKey)}
              icon={<Icon size={16} />}
              badge={
                place.id === "routines" && routineUnreadCount > 0
                  ? routineUnreadCount > 99
                    ? "99+"
                    : String(routineUnreadCount)
                  : undefined
              }
              title={
                place.id === "agents" && weekCost != null && weekCost > 0
                  ? `${tr(place.labelKey)} · ${formatCost(weekCost)}`
                  : undefined
              }
              onClick={onCloseMobile}
            />
          );
        })}
      </div>
    </div>
  );

  const desktopPanel = (
    <aside className="w-sidebar max-w-[85vw] max-md:w-[86vw] max-md:max-w-[22rem] h-full flex flex-col bg-kin-sidebar shrink-0">
      {header(false)}
      {newChatBlock}
      <SessionList shell="sidebar" activeTaskId={selectedTaskId ?? null} />
      {footerIcons}
    </aside>
  );

  // The phone's K panel is entries only. A list here was a second copy of the
  // page behind it, with its own search box and its own idea of which row was
  // open; the list already has a home one tap away.
  const drawerEntries = [
    {
      key: "archived",
      path: "/sessions?scope=archived",
      label: tr("nav.archivedProjects"),
      icon: <IconArchive size={18} />,
      badge: 0,
    },
    ...["routines", "agents", "settings"].map((id) => {
      const place = placeById(id as PlaceId);
      const Icon = PLACE_ICONS[place.id];
      return {
        key: place.id,
        path: place.path,
        label: tr(place.labelKey),
        icon: <Icon size={18} />,
        badge: place.id === "routines" ? routineUnreadCount : 0,
      };
    }),
  ];
  // `NavLink` matches a path, not a query, so the archived entry's
  // `/sessions?scope=archived` looked active on the phone's plain list too.

  const drawerPanel = (
    <aside className="w-sidebar max-w-[85vw] max-md:w-[86vw] max-md:max-w-[22rem] h-full flex flex-col bg-kin-sidebar shrink-0">
      {header(true)}
      {importBlock}
      {newChatBlock}
      <nav className="flex-1 overflow-y-auto px-3 pb-4 space-y-1">
        {drawerEntries.map((entry) => (
          <NavLink
            key={entry.key}
            to={entry.path}
            onClick={onCloseMobile}
            className={({ isActive }) =>
              [
                "flex min-h-11 items-center gap-3 rounded-xl px-3 text-strong font-medium transition-colors",
                (entry.key === "archived" ? archivedScope : isActive)
                  ? "bg-[var(--kin-fill-strong)] text-kin-text"
                  : "text-kin-secondary hover:bg-[var(--kin-fill)] hover:text-kin-text",
              ].join(" ")
            }
          >
            {entry.icon}
            <span className="flex-1">{entry.label}</span>
            {entry.badge > 0 && (
              <span className="min-w-[18px] h-[18px] px-1 rounded-full bg-kin-blue text-micro font-semibold text-kin-on-brand flex items-center justify-center tabular-nums">
                {entry.badge > 99 ? "99+" : entry.badge}
              </span>
            )}
          </NavLink>
        ))}
      </nav>
    </aside>
  );

  return (
    <>
      {/* Desktop */}
      {wide && <div className="hidden md:flex h-full shrink-0 kin-zen-hide">{desktopPanel}</div>}

      {/*
        The phone's edge. It is a strip rather than a listener on the shell
        root because a horizontal drag needs `touch-action: pan-y` from the
        very first touch: touch-action is decided when the finger lands, so a
        root-level listener could not stop the browser from interpreting the
        pull as a pan. `pan-y` leaves vertical scrolling alone; every page's
        content starts at least a thumb's width inside this 20px band.
      */}
      {!wide && !drawerSwipe.mounted && (
        <div
          aria-hidden="true"
          className="fixed inset-y-0 left-0 z-30 w-5 md:hidden"
          style={{ touchAction: "pan-y" }}
          {...drawerSwipe.edgeProps}
        />
      )}

      {/* Mobile drawer */}
      {!wide && drawerSwipe.mounted && (
        <div
          className="md:hidden fixed inset-0 z-40 flex"
          style={{ touchAction: "pan-y" }}
          {...drawerSwipe.drawerProps}
        >
          <button
            type="button"
            className={`absolute inset-0 bg-black/50 ${
              drawerSwipe.gestureDriven ? "" : "kin-scrim-enter"
            }`}
            style={{ opacity: drawerSwipe.progress }}
            aria-label={tr("app.closeMenu")}
            onClick={onCloseMobile}
          />
          <div
            /*
              `fixed` means the viewport is this box's containing block, so the
              root's `.safe-pad` does not reach it: the drawer re-applies both
              top and bottom insets itself, or its first row sits inside the
              sensor housing and its last one under the home indicator. The
              insets go on this box rather than on the panel inside it because
              the panel's background is what has to stay edge to edge — with the
              padding on the panel, the inset strips showed the scrim instead of
              the sidebar.
            */
            className={`relative z-10 h-full shadow-e3 bg-kin-sidebar pt-[env(safe-area-inset-top)] pb-[env(safe-area-inset-bottom)] ${
              drawerSwipe.gestureDriven ? "" : "kin-drawer-enter"
            }`}
            style={{
              transform: `translateX(${(drawerSwipe.progress - 1) * 100}%)`,
              transition: drawerSwipe.dragging
                ? "none"
                : "transform 180ms cubic-bezier(0.2, 0, 0, 1)",
            }}
          >
            {drawerPanel}
          </div>
        </div>
      )}
    </>
  );
}

function FooterIcon({
  to,
  label,
  icon,
  badge,
  title,
  onClick,
}: {
  to: string;
  label: string;
  icon: ReactNode;
  badge?: string;
  title?: string;
  onClick: () => void;
}) {
  const tr = useT();
  return (
    <NavLink
      to={to}
      onClick={onClick}
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
