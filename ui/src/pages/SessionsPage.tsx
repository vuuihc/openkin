import { useEffect } from "react";
import { useNavigate } from "react-router-dom";
import PhoneFooter from "../components/layout/PhoneFooter";
import { IconPencil } from "../components/icons";
import SessionList from "../components/sessions/SessionList";
import { useT } from "../i18n/react";
import { DRAFT_PATH } from "../lib/draftChat";
import { focusPlaceReturn, rememberPlaceReturn, takePlaceReturn } from "../lib/placeReturn";

/**
 * The conversation list, as a page — the phone's only navigation surface.
 *
 * All of the list lives in `SessionList`: the sidebar draws the same component
 * in its column. What this wrapper adds is the rest of the surface: the
 * footer's four destinations and the new-chat button (KIN-CONTINUE-002). The
 * footer is outside the list's scroll body, so it survives loading, empty,
 * read-failure and offline states; the button floats above it, and comes back
 * into focus when a draft is closed.
 */
export default function SessionsPage() {
  const tr = useT();
  const navigate = useNavigate();
  // Read-and-clear belongs in the effect, not a state initializer: StrictMode
  // runs initializers twice in development, and the first run would spend the
  // mark before the focused element exists.
  useEffect(() => {
    const returnTo = takePlaceReturn();
    if (returnTo) focusPlaceReturn(returnTo);
  }, []);

  return (
    <div className="relative flex flex-1 min-h-0 flex-col">
      <SessionList shell="page" />
      {/* The footer comes before the button in the DOM so Tab reaches the four
          destinations before the floating new-chat action, matching the order
          the screen reads (KIN-CONTINUE-002, step 1). Position is unaffected:
          the button is absolutely placed. */}
      <PhoneFooter />
      <button
        type="button"
        data-phone-return="new"
        onClick={() => {
          rememberPlaceReturn("new");
          navigate(DRAFT_PATH);
        }}
        aria-label={tr("nav.newChat")}
        title={tr("nav.newChat")}
        className="absolute bottom-[4.5rem] right-4 z-20 flex h-14 w-14 items-center justify-center rounded-full bg-kin-text text-kin-bg shadow-e2 transition-transform active:scale-[0.97] md:hidden kin-zen-hide"
      >
        <IconPencil size={24} strokeWidth={1.9} />
      </button>
    </div>
  );
}
