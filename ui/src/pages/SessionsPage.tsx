import SessionList from "../components/sessions/SessionList";

/**
 * The conversation list, as a page.
 *
 * All of the list lives in `SessionList`: the sidebar draws the same
 * component in its column. This wrapper exists so the route keeps a page of
 * its own — the phone's shell wraps it with the identity/search header and the
 * dock — without a second implementation underneath.
 */
export default function SessionsPage() {
  return <SessionList shell="page" />;
}
