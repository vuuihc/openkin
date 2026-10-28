import { NavLink, useLocation, useNavigate } from "react-router-dom";
import type { ReactNode } from "react";
import { useT } from "../../i18n/react";
import { DRAFT_PATH } from "../../lib/draftChat";
import { placePath, type PlaceId } from "../../lib/places";
import { IconInbox, IconPlus, IconSessions, IconSettings } from "../icons";

/**
 * The phone's primary navigation: a floating pill.
 *
 * It replaces a full-width bar with a top border. The difference is not
 * decoration — a bar welded to the bottom edge reads as the end of the page,
 * while a pill that floats over it reads as a control that is always there,
 * and it lets the list scroll visibly underneath instead of stopping at a
 * line. The FAB is separate from the dock on purpose: "go somewhere" and
 * "start something" are different kinds of action, and one of them deserves
 * the largest target on the screen.
 *
 * Sizes follow the dock the rest of the phone vocabulary uses: 56px tall,
 * 22px glyphs, 11px labels, a 20% accent wash under the active tab.
 *
 * `position: fixed` (not a flex child): the dock floats over the scroll
 * container, and the shell pads `<main>` by the dock's height while it is on
 * screen. It re-applies the bottom safe-area inset itself, because a fixed box
 * escapes the shell's `.safe-pad`.
 */
type Props = {
  /** Approvals waiting on a decision, shown on the inbox tab. */
  pendingCount: number;
};

export default function MobileDock({ pendingCount }: Props) {
  const tr = useT();
  const navigate = useNavigate();
  const location = useLocation();
  // "Start something" belongs to the screen that lists what has been started.
  // On settings it floated over the last card, offering a new chat on a page
  // about configuration.
  const onSessions = location.pathname.startsWith(placePath("sessions"));
  const tabs: { id: PlaceId; label: string; icon: ReactNode }[] = [
    { id: "sessions", label: tr("nav.sessions"), icon: <IconSessions size={22} /> },
    { id: "inbox", label: tr("nav.inbox"), icon: <IconInbox size={22} /> },
    { id: "settings", label: tr("nav.settings"), icon: <IconSettings size={22} /> },
  ];

  return (
    <div className="pointer-events-none fixed inset-x-0 bottom-0 z-30 px-4 pb-[max(0.75rem,env(safe-area-inset-bottom))] md:hidden kin-zen-hide">
      <div className="relative mx-auto w-full max-w-[26rem]">
        {onSessions && (
          <button
            type="button"
            onClick={() => navigate(DRAFT_PATH)}
            aria-label={tr("nav.newChat")}
            title={tr("nav.newChat")}
            className="pointer-events-auto absolute -top-[4.5rem] right-0 flex h-14 w-14 items-center justify-center rounded-full bg-kin-blue text-kin-on-brand shadow-e2 transition-[filter] active:brightness-95"
          >
            <IconPlus size={26} strokeWidth={2.1} />
          </button>
        )}
        <nav
          aria-label={tr("nav.primary")}
          className="pointer-events-auto flex h-14 items-stretch gap-0.5 rounded-full kin-glass p-1.5 shadow-e2"
        >
          {tabs.map((tab) => (
            <NavLink
              key={tab.id}
              to={placePath(tab.id)}
              className={({ isActive }) =>
                [
                  "relative flex min-w-0 flex-1 flex-col items-center justify-center gap-0.5 rounded-full text-micro font-semibold transition-colors",
                  isActive ? "bg-kin-blue/15 text-kin-blue-ink" : "text-kin-muted",
                ].join(" ")
              }
            >
              {tab.icon}
              <span className="truncate leading-flush">{tab.label}</span>
              {tab.id === "inbox" && pendingCount > 0 && (
                <span className="absolute right-[18%] top-0.5 inline-flex h-[17px] min-w-[17px] items-center justify-center rounded-full bg-kin-orange px-1 text-micro font-bold leading-flush text-kin-on-status tabular-nums">
                  {pendingCount > 99 ? "99+" : pendingCount}
                </span>
              )}
            </NavLink>
          ))}
        </nav>
      </div>
    </div>
  );
}
