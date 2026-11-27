import { useMemo } from "react";
import { Link, useLocation, useNavigate } from "react-router-dom";
import { usePendingResources } from "../../api/useLiveResources";
import { placeById } from "../../lib/places";
import { useT } from "../../i18n/react";
import { rememberPlaceReturn } from "../../lib/placeReturn";
import {
  onGuardedLinkClick,
  PHONE_TAB_IDS,
  phoneTabUrl,
  returnListUrl,
} from "../../lib/phoneNavigation";
import { pendingCountsByTask } from "../../lib/pendingCounts";
import { PLACE_ICONS } from "../placeIcons";
import PendingBadge from "../ui/PendingBadge";

const TABS = PHONE_TAB_IDS.map((id) => ({ ...placeById(id), id }));

/**
 * Shared phone navigation, on all four roots and through all their states.
 * Archive remains a filter under Chats, rather than taking its place.
 *
 * Each tab comes back to where the reader last was in that area: the list with
 * its search/status/scope, Routines with its machine, Settings with its tab.
 * The footer only has to ask for the remembered URL; `phoneTabUrl` refuses a
 * stale value that no longer names that root.
 *
 * Chats carries how many things wait on the reader, summed over conversations:
 * the tab is the one entry to the list, and "3 waiting" is the fact a person
 * would otherwise have to open the list to learn. The count is a mark inside
 * the link, never a second control, and the tap target stays the whole row.
 */
export default function PhoneFooter() {
  const tr = useT();
  const location = useLocation();
  const navigate = useNavigate();
  const pending = usePendingResources();
  const waiting = useMemo(() => {
    let total = 0;
    for (const count of pendingCountsByTask(pending.data).values()) total += count.total;
    return total;
  }, [pending.data]);
  // Agent Ops lives on the settings page as a tab, so the pathname alone cannot
  // tell the two tabs apart: the `tab` param is what makes it Agent Ops.
  const onOperations =
    location.pathname === "/settings" &&
    new URLSearchParams(location.search).get("tab") === "operations";

  return (
    <nav
      data-phone-tabs
      aria-label={tr("nav.primary")}
      data-phone-footer
      /*
        One floating surface, over the content rather than under it. The gap,
        the bar height and the clearance the pages below reserve are declared
        once in `index.css` (`--phone-footer-*`); this element names them
        instead of repeating the numbers.
      */
      className="md:hidden absolute inset-x-[var(--phone-footer-gap)] bottom-[var(--phone-footer-gap)] z-20 min-h-[var(--phone-footer-bar)] p-0.5 kin-glass kin-zen-hide"
    >
      <div className="grid grid-cols-4">
        {TABS.map((place) => {
          const Icon = PLACE_ICONS[place.id];
          // Each entry asks for its own remembered URL. Agent Ops and Settings
          // share a pathname but not a memory key (see `phoneTabPath`), so
          // Settings never reopens the operations tab.
          const to =
            place.id === "sessions" ? returnListUrl(location) : phoneTabUrl(place.id, place.path);
          const active =
            place.id === "agents"
              ? onOperations
              : place.id === "settings"
                ? location.pathname === "/settings" && !onOperations
                : location.pathname === place.path;
          return (
            <Link
              key={place.id}
              to={to}
              data-phone-return={place.id}
              aria-current={active ? "page" : undefined}
              onClick={(event) => {
                if (onGuardedLinkClick(event, navigate, location, to)) {
                  if (place.id !== "sessions") rememberPlaceReturn(place.id);
                }
              }}
              className={[
                "flex min-h-12 items-center justify-center rounded-full px-1 transition-colors",
                "focus-visible:outline focus-visible:outline-2 focus-visible:outline-offset-2 focus-visible:outline-kin-focus-ring",
                active ? "text-kin-on-brand" : "text-kin-secondary hover:text-kin-text",
              ].join(" ")}
            >
              {/* The capsule is the selected state; the icon inside keeps the
                  same glyph, so the four entries never change shape. */}
              <span
                data-phone-tab-icon
                className={[
                  "flex h-10 w-12 items-center justify-center rounded-full transition-colors",
                  active ? "bg-kin-blue text-kin-on-brand" : "text-current",
                ].join(" ")}
              >
                <span className="relative inline-flex">
                  <Icon size={20} />
                  {place.id === "sessions" && (
                    <PendingBadge count={waiting} className="absolute -right-1 -top-0.5" />
                  )}
                </span>
              </span>
              {/* D2: the name is for the screen reader, not for the bar. */}
              <span className="sr-only">{tr(place.labelKey)}</span>
            </Link>
          );
        })}
      </div>
    </nav>
  );
}
