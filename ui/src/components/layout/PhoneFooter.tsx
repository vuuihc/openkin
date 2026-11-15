import { Link, NavLink, useLocation, useNavigate } from "react-router-dom";
import { useT } from "../../i18n/react";
import { placeById } from "../../lib/places";
import { rememberPlaceReturn } from "../../lib/placeReturn";
import { onGuardedLinkClick } from "../../lib/phoneNavigation";
import { IconArchive } from "../icons";
import { PLACE_ICONS } from "../placeIcons";

/**
 * The signed four destinations (KIN-CONTINUE-002 D1): archive is the list's
 * other scope, and routines / Agent Ops / settings are the destinations.
 * `PLACES` still carries the Mac-only places, so the footer names its ids
 * instead of taking everything that is not the list.
 */
const DESTINATION_IDS = ["routines", "agents", "settings"] as const;
const DESTINATIONS = DESTINATION_IDS.map((id) => placeById(id));

/**
 * The phone list page's footer: four destinations, always on screen.
 *
 * It replaces the K drawer and the floating dock (KIN-CONTINUE-002). The
 * archive is a same-page scope — it is a link to `/sessions?scope=archived`,
 * not a pushed screen — while routines, Agent Ops and settings are real pages
 * that push over the list and come back in one step. Import is not here: it
 * lives in Agent Ops, with the agents it imports from.
 *
 * It is a flex sibling of the list, not a fixed overlay: the list scrolls
 * above it, the footer never covers the last row, and the states (loading,
 * empty, read failure, offline) keep it because it is outside the list's
 * scroll body.
 */
export default function PhoneFooter() {
  const tr = useT();
  const location = useLocation();
  const navigate = useNavigate();
  const params = new URLSearchParams(location.search);
  const archivedScope = location.pathname === "/sessions" && params.get("scope") === "archived";
  // Archiving is a scope of this list, not a new address: keep the search and
  // status the reader already narrowed to when switching the scope.
  params.set("scope", "archived");
  const archiveTo = `/sessions?${params.toString()}`;

  return (
    <nav
      aria-label={tr("nav.primary")}
      data-phone-footer
      className="md:hidden flex-none border-t border-kin-hairline bg-kin-sidebar px-2 pb-1 pt-1 kin-zen-hide"
    >
      <div className="grid grid-cols-4">
        <Link
          to={archiveTo}
          data-phone-return="archived"
          aria-current={archivedScope ? "page" : undefined}
          // Archive is another view of this same screen, not a second copy to
          // walk back through: the phone contract rewrites the list entry
          // instead of pushing one (KIN-CONTINUE-002, "归档不换页").
          onClick={(event) => onGuardedLinkClick(event, navigate, location, archiveTo)}
          className={[
            "flex min-h-12 flex-col items-center justify-center gap-0.5 rounded-lg px-1 text-micro font-medium transition-colors",
            archivedScope
              ? "bg-kin-blue/10 text-kin-blue-ink"
              : "text-kin-muted hover:bg-[var(--kin-fill)] hover:text-kin-text",
          ].join(" ")}
        >
          <IconArchive size={20} />
          <span className="max-w-full truncate">{tr("nav.archivedProjects")}</span>
        </Link>
        {DESTINATIONS.map((place) => {
          const Icon = PLACE_ICONS[place.id];
          return (
            <NavLink
              key={place.id}
              to={place.path}
              data-phone-return={place.id}
              onClick={() => rememberPlaceReturn(place.id)}
              className={({ isActive }) =>
                [
                  "flex min-h-12 flex-col items-center justify-center gap-0.5 rounded-lg px-1 text-micro font-medium transition-colors",
                  isActive
                    ? "bg-kin-blue/10 text-kin-blue-ink"
                    : "text-kin-muted hover:bg-[var(--kin-fill)] hover:text-kin-text",
                ].join(" ")
              }
            >
              <Icon size={20} />
              <span className="max-w-full truncate">{tr(place.labelKey)}</span>
            </NavLink>
          );
        })}
      </div>
    </nav>
  );
}
