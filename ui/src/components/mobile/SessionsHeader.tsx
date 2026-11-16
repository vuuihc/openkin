import { useLocation, useNavigate } from "react-router-dom";
import { useT } from "../../i18n/react";
import { DRAFT_PATH } from "../../lib/draftChat";
import { draftEntryState, listUrlFor, phonePush } from "../../lib/phoneNavigation";
import { rememberPlaceReturn } from "../../lib/placeReturn";
import { IconPlus } from "../icons";
import Button from "../ui/Button";
import SessionsSearch from "./SessionsSearch";

/**
 * The phone list page's header: the page title, the one search field, and the
 * one way to start a chat.
 *
 * It replaces the identity disc, the drawer trigger and the settings button
 * (KIN-CONTINUE-002). The list page is the only navigation surface now, so
 * there is no menu to open; settings is one of the four footer destinations.
 * Search still writes `?search=`, so the field and the list cannot drift apart,
 * the query survives opening a session and coming back, and a deep link can
 * carry one. The field is `SessionsSearch`, shared with the page's desktop
 * header.
 *
 * New chat is the header's quiet peer action, not a floating filled circle
 * (S2b): the list is what draws the eye, so its first row is the primary thing
 * on screen and "New chat" is a secondary button beside the title. It carries
 * the place-return mark so closing the draft puts focus back here, and it
 * stamps the draft entry exactly as the old floating control did — closing
 * still restores this exact list, params included.
 */
export default function SessionsHeader() {
  const tr = useT();
  const navigate = useNavigate();
  const location = useLocation();

  return (
    <header className="md:hidden flex-none kin-glass relative z-30 pt-safe kin-zen-hide border-b border-[var(--kin-hairline)]">
      <div className="flex items-center justify-between gap-3 px-4 pb-1 pt-3">
        <h1 className="min-w-0 truncate text-title font-semibold tracking-tight text-kin-text">
          {tr("nav.sessions")}
        </h1>
        <Button
          variant="secondary"
          data-phone-return="new"
          aria-label={tr("nav.newChat")}
          onClick={() => {
            rememberPlaceReturn("new");
            // Closing the draft restores this exact list, params included. The
            // phone contract stamps the entry the same way every other push
            // does, so a later push can tell the list is its parent rather than
            // guessing from an index.
            phonePush(navigate, location, DRAFT_PATH, {
              state: draftEntryState(listUrlFor(location.search)),
            });
          }}
          className="flex-none"
        >
          {/* One nowrap row: Astryx wraps several children inside its own flex
              container, which a narrow header would otherwise stack. */}
          <span className="inline-flex items-center gap-2 whitespace-nowrap">
            <IconPlus size={16} strokeWidth={2} />
            <span>{tr("nav.newChat")}</span>
          </span>
        </Button>
      </div>
      <div className="px-4 pb-2">
        <SessionsSearch />
      </div>
    </header>
  );
}
