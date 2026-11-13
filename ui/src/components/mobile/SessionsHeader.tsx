import { useT } from "../../i18n/react";
import SessionsSearch from "./SessionsSearch";

/**
 * The phone list page's header: the page title and the one search field.
 *
 * It replaces the identity disc, the drawer trigger and the settings button
 * (KIN-CONTINUE-002). The list page is the only navigation surface now, so
 * there is no menu to open; settings is one of the four footer destinations.
 * Search still writes `?search=`, so the field and the list cannot drift apart,
 * the query survives opening a session and coming back, and a deep link can
 * carry one. The field is `SessionsSearch`, shared with the page's desktop
 * header.
 */
export default function SessionsHeader() {
  const tr = useT();

  return (
    <header className="md:hidden flex-none kin-glass relative z-30 pt-safe kin-zen-hide border-b border-[var(--kin-hairline)]">
      <div className="px-4 pb-1 pt-3">
        <h1 className="text-title font-semibold tracking-tight text-kin-text">
          {tr("nav.sessions")}
        </h1>
      </div>
      <div className="px-4 pb-2">
        <SessionsSearch />
      </div>
    </header>
  );
}
