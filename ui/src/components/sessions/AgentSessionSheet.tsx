import { useEffect, useMemo, useRef, useState } from "react";
import { useLocation, useNavigate } from "react-router-dom";
import {
  ApiError,
  attachAgentSession,
  getAgentSession,
  getAgentSessionHistory,
  isAuthenticated,
  type AgentSession,
  type AgentSessionHistoryItem,
} from "../../api/client";
import { useAgentRoles } from "../../hooks/useAgentRoles";
import { useCoarsePointer } from "../../hooks/useMediaQuery";
import { useT } from "../../i18n/react";
import { agentAvatarMeta, agentDisplayName } from "../../lib/agentMention";
import {
  agentSessionHistoryToTaskEvents,
  agentSessionTurnStart,
  countAgentSessionUserTurns,
} from "../../lib/agentSessionHistory";
import { canContinueAgentSession, displayAgentSessionTitle } from "../../lib/agentSessionTitle";
import { runGuardedNavigation } from "../../lib/leaveGuard";
import { currentPhoneLocation, phonePush } from "../../lib/phoneNavigation";
import { useAppStore } from "../../store/appStore";
import ChatStream from "../chat/ChatStream";
import Composer from "../chat/Composer";
import Sheet from "../mobile/Sheet";
import { SkeletonLine } from "../Skeleton";
import Button from "../ui/Button";
import InlineAlert from "../ui/InlineAlert";
import { IconX } from "../icons";

/**
 * The imported agent session, opened over the list.
 *
 * The row used to leave `/sessions` for the full page, which cost the list's
 * place on the way back. The sheet keeps the reader where they chose the row:
 * the same newest-three-turns window the page opens on, the same agent and
 * status, and one composer that does exactly what the page's does — attach the
 * source session to a new Kin task and land on it.
 *
 * The page is still the deep-link and cold-entry surface. This file reads the
 * same helpers and copies the page's opening budget rather than growing a
 * second definition of "recent": a shared module would have to be exported
 * from a route, and the numbers are part of the projection, not of the page.
 */

const HISTORY_PAGE = 30;
const HISTORY_INITIAL_TURNS = 3;
const HISTORY_INITIAL_MAX_TEXT = 256 << 10;
const HISTORY_INITIAL_MAX_PAGES = 6;
const historyTextEncoder = new TextEncoder();

function historyTextBytes(items: AgentSessionHistoryItem[]): number {
  return items.reduce((total, item) => total + historyTextEncoder.encode(item.text).length, 0);
}

/**
 * Read the newest turns the page would open on: newest page first, then older
 * pages only until the third-newest user turn is in hand, and never past the
 * byte or page ceiling. The sheet shows the same window and stops there; it
 * has no "load earlier", so reading past the budget would only grow the read.
 */
async function readOpeningHistory(id: string): Promise<{
  items: AgentSessionHistoryItem[];
  cut: boolean;
}> {
  const newest = await getAgentSessionHistory(id, { tail: true, limit: HISTORY_PAGE });
  let loaded = newest.items;
  let prev = newest.prev_cursor ?? "";
  let cut = Boolean(newest.truncated) && !prev;
  let pages = 1;
  while (
    pages < HISTORY_INITIAL_MAX_PAGES &&
    prev &&
    countAgentSessionUserTurns(loaded) < HISTORY_INITIAL_TURNS &&
    historyTextBytes(loaded) < HISTORY_INITIAL_MAX_TEXT
  ) {
    const older = await getAgentSessionHistory(id, { before: prev, limit: HISTORY_PAGE });
    if (older.items.length === 0) break;
    if (historyTextBytes([...older.items, ...loaded]) > HISTORY_INITIAL_MAX_TEXT) break;
    loaded = [...older.items, ...loaded];
    prev = older.prev_cursor ?? "";
    cut = Boolean(older.truncated) && !prev;
    pages += 1;
  }
  const start = agentSessionTurnStart(loaded, HISTORY_INITIAL_TURNS);
  return { items: loaded.slice(start), cut };
}

/** Why the sheet is closing. A successful continue is not a dismissal: on a
 *  Mac the list keeps its `?agent=` entry under the task it opens, so Back
 *  returns to the sheet the reader left. */
export type AgentSessionSheetClose = { reason?: "attach" };

export type AgentSessionSheetProps = {
  open: boolean;
  /**
   * The row's snapshot. It heads the sheet before the read lands (title, agent,
   * status) and stays the fallback when the refresh fails; the sheet only
   * needs an id of its own when it has no row behind it, which is not a
   * surface this console has.
   */
  session: AgentSession | null;
  /** The shell's channel state: a disconnected console can read what it has
   *  but cannot start the task the composer would start. */
  offline?: boolean;
  onClose: (close?: AgentSessionSheetClose) => void;
};

/**
 * The sheet's composer and the roles it offers.
 *
 * A component of its own so the role read belongs to the open surface: the
 * sheet stays mounted between opens to keep the turns it already read, and a
 * hook called at the sheet's top level would read settings on every console
 * start even with no sheet on screen.
 */
function ContinueComposer({
  agentName,
  busy,
  offline,
  onSubmit,
}: {
  agentName: string;
  busy: boolean;
  offline: boolean;
  onSubmit: (text: string) => Promise<void>;
}) {
  const tr = useT();
  const roles = useAgentRoles();
  return (
    <Composer
      busy={busy}
      disabled={busy}
      blockSend={offline}
      roles={roles}
      placeholder={tr("agentSession.continuePlaceholder", { agent: agentName })}
      onSubmit={onSubmit}
    />
  );
}

export default function AgentSessionSheet({
  open,
  session,
  offline = false,
  onClose,
}: AgentSessionSheetProps) {
  const tr = useT();
  const navigate = useNavigate();
  const location = useLocation();
  const locationRef = useRef(location);
  locationRef.current = location;
  const openRef = useRef(open);
  openRef.current = open;
  const coarse = useCoarsePointer();
  const reconnectGen = useAppStore((s) => s.reconnectGen);
  const [fresh, setFresh] = useState<AgentSession | null>(null);
  const [items, setItems] = useState<AgentSessionHistoryItem[]>([]);
  const [historyLoading, setHistoryLoading] = useState(false);
  const [historyError, setHistoryError] = useState<string | null>(null);
  const [historyCut, setHistoryCut] = useState(false);
  const [attachBusy, setAttachBusy] = useState(false);
  const [attachError, setAttachError] = useState<string | null>(null);
  const [reloadKey, setReloadKey] = useState(0);
  // The session the messages in `items` belong to. A reopen of the same row
  // keeps them on screen while the refresh is out (and keeps them when the
  // refresh fails); a different row starts clean.
  const loadedFor = useRef<string | null>(null);
  // The task an attach just created, navigated to only once the sheet's history
  // entry is behind us (Sheet's `onCloseComplete`).
  const pendingTask = useRef<string | null>(null);

  // The row's snapshot is what is on screen until the refresh names the same
  // id. A late answer for a session the reader has since replaced never paints
  // under the new title.
  const view = fresh && fresh.id === session?.id ? fresh : session;
  const sessionId = view?.id ?? "";

  useEffect(() => {
    if (!open || !sessionId) return;
    let cancelled = false;
    setHistoryError(null);
    setAttachError(null);
    if (loadedFor.current !== sessionId) {
      loadedFor.current = sessionId;
      setItems([]);
      setHistoryCut(false);
      // A refresh of another row must not supply this one's status.
      setFresh(null);
    }
    setHistoryLoading(true);
    void (async () => {
      if (!isAuthenticated()) {
        if (!cancelled) {
          setHistoryLoading(false);
          setHistoryError(tr("agentSession.historyFailed"));
        }
        return;
      }
      try {
        const repaired = await getAgentSession(sessionId);
        if (!cancelled) setFresh(repaired);
      } catch (e) {
        // The snapshot already heads the sheet. A failed refresh costs the
        // newest status, not the surface, so the history read still runs.
        if (!cancelled && !(e instanceof ApiError && e.status === 401)) {
          // Nothing to paint: the row's copy is the fallback.
        }
      }
      try {
        const page = await readOpeningHistory(sessionId);
        if (cancelled) return;
        setItems(page.items);
        setHistoryCut(page.cut);
      } catch (e) {
        if (cancelled || (e instanceof ApiError && e.status === 401)) return;
        setHistoryError(
          e instanceof ApiError && e.status === 501
            ? tr("agentSession.historyUnavailable")
            : e instanceof Error
              ? e.message
              : tr("agentSession.historyFailed"),
        );
      } finally {
        if (!cancelled) setHistoryLoading(false);
      }
    })();
    return () => {
      cancelled = true;
    };
  }, [open, sessionId, reconnectGen, reloadKey, tr]);

  const historyEvents = useMemo(
    () =>
      view
        ? agentSessionHistoryToTaskEvents(items, view.id, view.agent_id, {
            truncatedNotice: tr("agentSession.messageTruncated"),
          })
        : [],
    [items, view, tr],
  );

  if (!session || !view) return null;

  const agentName = agentDisplayName(view.agent_id);
  const avatar = agentAvatarMeta(view.agent_id);
  const title = displayAgentSessionTitle(
    view,
    tr("agentSession.sessionFallback", { agent: agentName }),
  );
  const canContinue = canContinueAgentSession(view);
  const missingContinueCwd =
    !view.linked && !view.cwd.trim() && view.capabilities?.includes("session_attach") === true;

  const attach = async (text: string) => {
    const prompt = text.trim();
    if (!prompt || attachBusy) return;
    // The answer belongs to the list the sheet was opened from. A reader who
    // left it (a notification, a footer tab) must not be pulled to a task by
    // this old answer; closing the sheet is not leaving the list, so that case
    // still lands on the task the button promised.
    const origin = {
      pathname: locationRef.current.pathname,
      key: locationRef.current.key,
      visit: currentPhoneLocation()?.visit,
    };
    setAttachBusy(true);
    setAttachError(null);
    try {
      const result = await attachAgentSession(view.id, { prompt });
      window.dispatchEvent(new Event("kin:agent-sessions-changed"));
      const tracked = currentPhoneLocation();
      const now = tracked ?? locationRef.current;
      if (now.pathname !== origin.pathname || now.key !== origin.key) return;
      if (
        origin.visit !== undefined &&
        tracked?.visit !== undefined &&
        tracked.visit !== origin.visit
      ) {
        return;
      }
      const to = `/tasks/${encodeURIComponent(result.task.id)}`;
      // The list is below this sheet, not the session's own page: a plain push
      // keeps it as the one Back. (The page replaces its own entry because
      // that entry sits above the list; there is no such entry here.)
      const go = () => runGuardedNavigation(() => phonePush(navigate, locationRef.current, to));
      if (!openRef.current) {
        go();
        return;
      }
      pendingTask.current = result.task.id;
      onClose({ reason: "attach" });
    } catch (e) {
      const message = e instanceof Error ? e.message : tr("agentSession.continueFailed");
      setAttachError(message);
      throw new Error(message);
    } finally {
      setAttachBusy(false);
    }
  };

  const closeComplete = () => {
    const taskId = pendingTask.current;
    if (!taskId) return;
    pendingTask.current = null;
    runGuardedNavigation(() =>
      phonePush(navigate, locationRef.current, `/tasks/${encodeURIComponent(taskId)}`),
    );
  };

  const footer = canContinue ? (
    <div className="space-y-1.5">
      {attachError ? <InlineAlert>{attachError}</InlineAlert> : null}
      {offline ? (
        <p className="text-caption text-kin-muted">{tr("agentSession.continueOffline")}</p>
      ) : null}
      <ContinueComposer
        key={view.id}
        agentName={agentName}
        busy={attachBusy}
        offline={offline}
        onSubmit={attach}
      />
    </div>
  ) : missingContinueCwd ? (
    <p className="text-caption text-kin-muted">{tr("agentSession.continueUnavailable")}</p>
  ) : undefined;

  // The agent and its status stay in the sheet's fixed header: the transcript
  // scrolls under them, so the × never leaves the screen.
  const agentRow = (
    <div className="flex items-start gap-2">
      <span
        className={[
          "mt-0.5 inline-flex h-7 w-7 flex-none items-center justify-center rounded-lg text-caption font-semibold",
          avatar.className,
        ].join(" ")}
        role="img"
        aria-label={avatar.label}
      >
        {avatar.initials}
      </span>
      <div className="min-w-0 flex-1">
        <p className="truncate text-body font-medium text-kin-text">{agentName}</p>
        <p className="mt-0.5 truncate text-caption text-kin-muted">
          {view.status} ·{" "}
          {view.linked
            ? tr("agentSession.connected")
            : canContinue
              ? tr("agentSession.available")
              : tr("agentSession.readOnly")}
        </p>
      </div>
      {/* A sheet's scrim closes it, but a reader on a tablet should not have
          to know that: the same control every other panel carries. The floor
          follows the pointer, not the width (AGENTS 16). */}
      <Button
        variant="quiet"
        onClick={() => onClose()}
        aria-label={tr("common.close")}
        className={`${coarse ? "h-11 w-11" : "h-7 w-7"} flex-none p-0`}
      >
        <IconX size={16} className="text-kin-muted" />
      </Button>
    </div>
  );

  return (
    <Sheet
      open={open}
      onClose={onClose}
      onCloseComplete={closeComplete}
      title={title}
      anyWidth
      grip={coarse}
      header={agentRow}
      bodyClassName="pb-2"
      footer={footer}
    >
      {historyError ? (
        <InlineAlert className="mb-2">
          <div className="flex flex-wrap items-center gap-2">
            <span>{historyError}</span>
            <Button variant="secondary" onClick={() => setReloadKey((key) => key + 1)}>
              {tr("agentSession.historyRetry")}
            </Button>
          </div>
        </InlineAlert>
      ) : null}
      {historyCut && items.length > 0 ? (
        <p className="pb-2 text-caption text-kin-muted">{tr("agentSession.historyTruncated")}</p>
      ) : null}
      {historyLoading && items.length === 0 ? (
        <div className="space-y-2 py-2">
          <SkeletonLine className="h-16 w-full" />
          <SkeletonLine className="h-12 w-5/6" />
        </div>
      ) : null}
      {!historyLoading && !historyError && items.length === 0 ? (
        <p className="py-8 text-center text-strong text-kin-muted">
          {tr("agentSession.historyEmpty")}
        </p>
      ) : null}
      {items.length > 0 ? (
        <ChatStream
          events={historyEvents}
          loadingSpeaker={view.agent_id}
          hostSpeaker={view.agent_id}
          hideFirstSpeaker
        />
      ) : null}
    </Sheet>
  );
}
