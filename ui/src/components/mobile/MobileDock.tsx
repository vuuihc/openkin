import { NavLink, useLocation, useNavigate } from "react-router-dom";
import type { ReactNode } from "react";
import { useT } from "../../i18n/react";
import { DRAFT_PATH } from "../../lib/draftChat";
import { placePath, type PlaceId } from "../../lib/places";
import { IconPencil, IconProjects, IconRoutines, IconSessions } from "../icons";

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
export default function MobileDock() {
  const tr = useT();
  const navigate = useNavigate();
  const location = useLocation();
  // "Start something" belongs to the screen that lists what has been started.
  // On settings it floated over the last card, offering a new chat on a page
  // about configuration.
  const onSessions = location.pathname.startsWith(placePath("sessions"));
  // The dock is for going places, not for configuration: inbox and settings
  // moved into the conversation list's header, where the reference keeps them,
  // which leaves the three destinations that are the product's actual loop.
  const tabs: { id: PlaceId; label: string; icon: ReactNode }[] = [
    { id: "sessions", label: tr("nav.sessions"), icon: <IconSessions size={22} /> },
    { id: "routines", label: tr("nav.routines"), icon: <IconRoutines size={22} /> },
    { id: "projects", label: tr("nav.projects"), icon: <IconProjects size={22} /> },
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
            className="pointer-events-auto absolute -top-[4.5rem] right-0 flex h-14 w-14 items-center justify-center rounded-full bg-kin-text text-kin-bg shadow-e2 transition-transform active:scale-[0.97]"
          >
            <IconPencil size={24} strokeWidth={1.9} />
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
            </NavLink>
          ))}
        </nav>
      </div>
    </div>
  );
}
