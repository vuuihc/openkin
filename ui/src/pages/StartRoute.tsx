import { Navigate } from "react-router-dom";
import { lastConversation } from "../lib/lastConversation";

/**
 * Where `/` goes. Opening the app without touching anything puts the reader
 * back in the conversation they left — the list stays one level up — and a
 * first run lands on the draft instead.
 */
export default function StartRoute() {
  const last = lastConversation();
  return <Navigate to={last ? `/tasks/${encodeURIComponent(last)}` : "/new"} replace />;
}
