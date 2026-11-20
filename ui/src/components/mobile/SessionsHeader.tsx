import { useEffect, useId, useRef, useState } from "react";
import { useLocation, useNavigate, useSearchParams } from "react-router-dom";
import { useT } from "../../i18n/react";
import { DRAFT_PATH } from "../../lib/draftChat";
import { draftEntryState, listUrlFor, phonePush } from "../../lib/phoneNavigation";
import { rememberPlaceReturn } from "../../lib/placeReturn";
import { IconPlus, IconSearch } from "../icons";
import Button from "../ui/Button";
import SessionsSearch from "./SessionsSearch";

/**
 * The phone list page's header: the page title, the one search field behind a
 * magnifier, and the one way to start a chat.
 *
 * It replaces the identity disc, the drawer trigger and the settings button
 * (KIN-CONTINUE-002). The list page is the only navigation surface now, so
 * there is no menu to open; settings is one of the four footer destinations.
 *
 * Search is disclosed rather than always open (KIN-CONTINUE-004): the first
 * screen belongs to the conversations, and a field that is always there costs
 * a row of them. The magnifier opens the same `SessionsSearch`, which still
 * writes `?search=`, so the field and the list cannot drift apart. A query is
 * a filter that is on screen, so it keeps the field open — a deep link, the
 * back button, or a restored list may all arrive with one.
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
  const [params] = useSearchParams();
  const query = params.get("search") ?? "";
  // A cold start with `?search=` opens the field without focusing it: the
  // filter belongs to the address, not to a keyboard the reader did not ask
  // for. Focus follows only the magnifier press that disclosed the field.
  const [open, setOpen] = useState(query !== "");
  const [focusOnOpen, setFocusOnOpen] = useState(false);
  const magnifier = useRef<HTMLButtonElement>(null);
  const panelId = useId();

  useEffect(() => {
    if (query) setOpen(true);
  }, [query]);

  function dismissSearch() {
    setOpen(false);
    setFocusOnOpen(false);
    // The trigger is where the reader came from; leaving focus on a field that
    // no longer exists would drop it to the document.
    magnifier.current?.focus();
  }

  return (
    <header className="md:hidden flex-none kin-glass relative z-30 pt-safe kin-zen-hide border-b border-[var(--kin-hairline)]">
      <div className="flex items-center justify-between gap-3 px-4 pb-1 pt-3">
        <h1 className="min-w-0 truncate text-title font-semibold tracking-tight text-kin-text">
          {tr("nav.sessions")}
        </h1>
        <div className="flex flex-none items-center gap-1">
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
          <Button
            ref={magnifier}
            variant="quiet"
            aria-label={tr("sessions.searchPlaceholder")}
            aria-expanded={open}
            aria-controls={panelId}
            onClick={() => {
              if (!open) {
                setFocusOnOpen(true);
                setOpen(true);
                return;
              }
              // A query on screen cannot be folded away: the short list would
              // then have no visible cause.
              if (!query) dismissSearch();
            }}
            className={[
              "h-11 w-11 flex-none items-center justify-center rounded-full p-0 text-kin-muted!",
              open ? "bg-[var(--kin-fill)]!" : "",
            ].join(" ")}
          >
            <IconSearch size={18} strokeWidth={2} />
          </Button>
        </div>
      </div>
      {open ? (
        <div id={panelId} className="px-4 pb-2">
          <SessionsSearch autoFocus={focusOnOpen} onDismiss={dismissSearch} />
        </div>
      ) : null}
    </header>
  );
}
