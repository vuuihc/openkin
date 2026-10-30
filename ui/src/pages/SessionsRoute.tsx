import { useMinWidth } from "../hooks/useMinWidth";
import NewChatPage from "./NewChatPage";
import SessionsPage from "./SessionsPage";

/**
 * `/sessions` is one place with one list, and the list has a different home on
 * each width.
 *
 * On a phone the page is the list: there is no sidebar to hold it, and the
 * conversation opens as a pushed screen. On a Mac the sidebar already is the
 * list (device → project → conversation, the only one in the window), so the
 * main area shows the draft instead of drawing the same rows and a second
 * search field beside it. Both branches read the same tables, so the two
 * widths cannot disagree about what a conversation is.
 *
 * `?scope=archived` stays a meaningful address on a Mac, but it selects the
 * sidebar's archived section (see `Sidebar`); it does not bring the list back
 * into the main area. Two lists side by side, each with its own search, is the
 * thing this route exists to stop.
 */
export default function SessionsRoute() {
  const wide = useMinWidth(768);
  return wide ? <NewChatPage /> : <SessionsPage />;
}
