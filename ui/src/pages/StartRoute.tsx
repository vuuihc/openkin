import { Navigate } from "react-router-dom";
import { useMinWidth } from "../hooks/useMinWidth";
import { lastConversation } from "../lib/lastConversation";

/**
 * Where `/` goes.
 *
 * On a Mac, opening the app without touching anything puts the reader back in
 * the conversation they left — the list stays beside it — and a first run
 * lands on the draft.
 *
 * On a phone the list is the navigation root, so it is also the home: opening
 * the app shows the one navigation surface, not a conversation with the list
 * hidden a level up (KIN-CONTINUE-002, step 1). This supersedes the phone half
 * of KIN-CONTINUE-001's step 1, which was signed before the list became the
 * phone's only navigation surface.
 */
export default function StartRoute() {
  const wide = useMinWidth(768);
  if (!wide) return <Navigate to="/sessions" replace />;
  const last = lastConversation();
  return <Navigate to={last ? `/tasks/${encodeURIComponent(last)}` : "/new"} replace />;
}
