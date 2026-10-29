import { useEffect, useRef } from "react";

/**
 * Close a `md:hidden` overlay when the viewport is, or becomes, wide.
 *
 * Past 768px such an overlay is still *mounted and open in state*, just
 * invisible. Anything keyed on that state then keeps behaving as if the
 * overlay were on screen: the phone's navigation drawer suppresses the
 * floating approval while it is open, and every control that could close it
 * lives inside the hidden subtree — so a rotation, or a phone-sized window
 * dragged wide, would hide every later approval for the rest of the session.
 *
 * `close` is read through a ref: the caller passes an inline arrow, and an
 * effect that re-subscribed on every render would spend the drawer's open
 * lifetime adding and removing listeners.
 */
export function useCloseOnWideScreen(open: boolean, close: () => void) {
  const closeRef = useRef(close);
  closeRef.current = close;

  useEffect(() => {
    if (!open || typeof window.matchMedia !== "function") return;
    const media = window.matchMedia("(min-width: 768px)");
    if (media.matches) {
      closeRef.current();
      return;
    }
    const onChange = () => {
      if (media.matches) closeRef.current();
    };
    media.addEventListener?.("change", onChange);
    return () => media.removeEventListener?.("change", onChange);
  }, [open]);
}
