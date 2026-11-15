import { useLocation, useNavigate } from "react-router-dom";
import { IconPencil } from "../components/icons";
import SessionList from "../components/sessions/SessionList";
import { useT } from "../i18n/react";
import { DRAFT_PATH } from "../lib/draftChat";
import { draftEntryState, listUrlFor, phonePush } from "../lib/phoneNavigation";
import { rememberPlaceReturn } from "../lib/placeReturn";

/**
 * The conversation list is one of the phone's four peer roots. `SessionList`
 * also serves the Mac sidebar; the AppShell supplies the shared footer.
 * Keeping its search, status and archive scope in this page, rather than
 * creating a second archive destination, preserves the list's restoration.
 * The phone's new-chat button floats above that footer and regains focus when
 * its draft closes (KIN-CONTINUE-002).
 */
export default function SessionsPage() {
  const tr = useT();
  const navigate = useNavigate();
  const location = useLocation();
  // AppShell owns one-shot footer's focus after a root route commits.

  return (
    <div className="relative flex flex-1 min-h-0 flex-col">
      <SessionList shell="page" />
      {/* The shell owns the shared footer after <main>, outside this button's
          containing block. Leave only a small gap rather than adding the
          footer's height a second time; focus still returns to this control. */}
      <button
        type="button"
        data-phone-return="new"
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
        aria-label={tr("nav.newChat")}
        title={tr("nav.newChat")}
        className="absolute bottom-4 right-4 z-20 flex h-14 w-14 items-center justify-center rounded-full bg-kin-text text-kin-bg shadow-e2 transition-transform active:scale-[0.97] md:hidden kin-zen-hide"
      >
        <IconPencil size={24} strokeWidth={1.9} />
      </button>
    </div>
  );
}
