import SessionList from "../components/sessions/SessionList";

/**
 * The conversation list is one of the phone's four peer roots. `SessionList`
 * also serves the Mac sidebar; the AppShell supplies the shared footer and the
 * list's header, whose New chat action opens the draft.
 *
 * Keeping its search, status and archive scope in this page, rather than
 * creating a second archive destination, preserves the list's restoration.
 */
export default function SessionsPage() {
  return (
    <div className="flex flex-1 min-h-0 flex-col">
      <SessionList shell="page" />
    </div>
  );
}
