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
    for (const count of pendingCountsByTask(pending.data).values()) total += count;
    return total;
  }, [pending.data]);

  return (
    <nav
      data-phone-tabs
      aria-label={tr("nav.primary")}
      data-phone-footer
      className="md:hidden flex-none border-t border-kin-hairline bg-kin-sidebar px-2 pb-1 pt-1 kin-zen-hide"
    >
      <div className="grid grid-cols-4">
        {TABS.map((place) => {
          const Icon = PLACE_ICONS[place.id];
          const to = place.id === "sessions" ? returnListUrl(location) : phoneTabUrl(place.id);
          const active = location.pathname === place.path;
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
                "flex min-h-12 flex-col items-center justify-center gap-0.5 rounded-lg px-1 text-micro font-medium transition-colors",
                active
                  ? "bg-kin-blue/10 text-kin-blue-ink"
                  : "text-kin-muted hover:bg-[var(--kin-fill)] hover:text-kin-text",
              ].join(" ")}
            >
              <span className="relative inline-flex">
                <Icon size={20} />
                {place.id === "sessions" && (
                  <PendingBadge count={waiting} className="absolute -right-1 -top-0.5" />
                )}
              </span>
              <span className="max-w-full truncate">{tr(place.labelKey)}</span>
            </Link>
          );
        })}
      </div>
    </nav>
  );
}
