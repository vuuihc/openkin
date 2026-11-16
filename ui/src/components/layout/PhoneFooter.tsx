import { Link, useLocation, useNavigate } from "react-router-dom";
import { placeById } from "../../lib/places";
import { useT } from "../../i18n/react";
import { rememberPlaceReturn } from "../../lib/placeReturn";
import { onGuardedLinkClick, PHONE_TAB_IDS, returnListUrl } from "../../lib/phoneNavigation";
import { PLACE_ICONS } from "../placeIcons";

const TABS = PHONE_TAB_IDS.map((id) => placeById(id));

/**
 * Shared phone navigation, on all four roots and through all their states.
 * Archive remains a filter under Chats, rather than taking its place.
 */
export default function PhoneFooter() {
  const tr = useT();
  const location = useLocation();
  const navigate = useNavigate();

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
          const to = place.id === "sessions" ? returnListUrl(location) : place.path;
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
              <Icon size={20} />
              <span className="max-w-full truncate">{tr(place.labelKey)}</span>
            </Link>
          );
        })}
      </div>
    </nav>
  );
}
