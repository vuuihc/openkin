import { NavLink } from "react-router-dom";
import { useT } from "../../i18n/react";

/**
 * The phone's primary navigation: one tab per job the phone actually does —
 * see your sessions, answer what is waiting on you, change a setting.
 *
 * Desktop keeps the sidebar. This only ever renders below `md`, and the drawer
 * stays reachable from the header for everything the three tabs do not cover
 * (projects, agents, routines, artifacts).
 */

type Props = {
  /** Approvals waiting on a decision, shown on the inbox tab. */
  pendingCount: number;
};

const iconProps = {
  width: 23,
  height: 23,
  viewBox: "0 0 24 24",
  fill: "none",
  stroke: "currentColor",
  strokeWidth: 1.7,
  strokeLinecap: "round" as const,
  strokeLinejoin: "round" as const,
};

function SessionsIcon() {
  return (
    <svg {...iconProps} aria-hidden="true">
      <path d="M21 11.5a8.4 8.4 0 0 1-9 8.4 9 9 0 0 1-3.2-.6L3 21l1.7-4.6A8.4 8.4 0 0 1 12 3.1a8.4 8.4 0 0 1 9 8.4Z" />
    </svg>
  );
}

function InboxIcon() {
  return (
    <svg {...iconProps} aria-hidden="true">
      <path d="M4 5h16v11H7l-3 3V5Z" />
      <path d="M9 9.5h6" />
    </svg>
  );
}

function SettingsIcon() {
  return (
    <svg {...iconProps} aria-hidden="true">
      <circle cx="12" cy="12" r="3.2" />
      <path d="M19.4 15a1.7 1.7 0 0 0 .3 1.9l.1.1a2 2 0 1 1-2.8 2.8l-.1-.1a1.7 1.7 0 0 0-2.9 1.2v.2a2 2 0 1 1-4 0v-.1a1.7 1.7 0 0 0-2.9-1.3l-.1.1a2 2 0 1 1-2.8-2.8l.1-.1A1.7 1.7 0 0 0 2.6 14H2.4a2 2 0 1 1 0-4h.2a1.7 1.7 0 0 0 1.2-2.9l-.1-.1a2 2 0 1 1 2.8-2.8l.1.1A1.7 1.7 0 0 0 9.5 3V2.8a2 2 0 1 1 4 0V3a1.7 1.7 0 0 0 2.9 1.2l.1-.1a2 2 0 1 1 2.8 2.8l-.1.1a1.7 1.7 0 0 0 1.2 2.9h.2a2 2 0 1 1 0 4h-.2a1.7 1.7 0 0 0-1.5 1Z" />
    </svg>
  );
}

export default function MobileTabBar({ pendingCount }: Props) {
  const tr = useT();
  const tabs = [
    { to: "/sessions", label: tr("nav.sessions"), icon: <SessionsIcon /> },
    { to: "/inbox", label: tr("nav.inbox"), icon: <InboxIcon /> },
    { to: "/settings", label: tr("nav.settings"), icon: <SettingsIcon /> },
  ];

  return (
    /*
      No safe-area padding here on purpose: the AppShell root's `.safe-pad`
      already reserves the home-indicator strip below this bar. Adding
      `pb-safe` too left the bar floating ~34px above the bottom of the screen
      with dead space under it.
    */
    <nav
      className="md:hidden flex-none flex items-stretch border-t border-[var(--kin-hairline)] bg-[var(--kin-page)]"
      aria-label={tr("nav.primary")}
    >
      {tabs.map((tab) => (
        <NavLink
          key={tab.to}
          to={tab.to}
          className={({ isActive }) =>
            `relative flex-1 min-h-12 flex flex-col items-center justify-center gap-0.5 text-micro transition-colors ${
              isActive ? "text-kin-blue" : "text-kin-muted"
            }`
          }
        >
          {tab.icon}
          {tab.label}
          {tab.to === "/inbox" && pendingCount > 0 && (
            <span className="absolute top-1 left-1/2 ml-1 min-w-[17px] h-[17px] px-1 rounded-full bg-kin-orange text-[#1a1a1c] text-caption font-bold inline-flex items-center justify-center">
              {pendingCount}
            </span>
          )}
        </NavLink>
      ))}
    </nav>
  );
}
