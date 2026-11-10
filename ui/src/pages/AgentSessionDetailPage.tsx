import { useCallback, useEffect, useLayoutEffect, useMemo, useRef, useState } from "react";
import { Link, useNavigate, useParams } from "react-router-dom";
import {
  ApiError,
  attachAgentSession,
  getAgentSession,
  getAgentSessionHistory,
  isAuthenticated,
  type AgentSession,
  type AgentSessionHistoryItem,
} from "../api/client";
import ChatStream from "../components/chat/ChatStream";
import BranchPicker from "../components/chat/BranchPicker";
import Composer from "../components/chat/Composer";
import CwdPicker from "../components/chat/CwdPicker";
import { IconBack } from "../components/icons";
import { SkeletonLine, SlowConnectHint } from "../components/Skeleton";
import { useAgentRoles } from "../hooks/useAgentRoles";
import { useSlowHint } from "../hooks/useSlowHint";
import { useT } from "../i18n/react";
import { agentAvatarMeta, agentDisplayName } from "../lib/agentMention";
import { displayAgentSessionTitle } from "../lib/agentSessionTitle";
import { useAppStore } from "../store/appStore";
import { agentSessionHistoryToTaskEvents } from "../lib/agentSessionHistory";

// One answer from the machine holding the session carries at most this many
// messages. The first screen fills from the newest end up to a budget, not to
// the beginning: a session with hundreds of turns should open on what happened
// last, and the budget is what keeps "show the latest" from becoming "fetch
// everything first". 200 matches the routine run history's cap, so the console
// has one number for how much history opens at once.
const HISTORY_PAGE = 100;
const HISTORY_INITIAL_MAX_ITEMS = 200;
const HISTORY_INITIAL_MAX_TEXT = 1 << 20;
const historyTextEncoder = new TextEncoder();

function historyTextBytes(items: AgentSessionHistoryItem[]): number {
  return items.reduce((total, item) => total + historyTextEncoder.encode(item.text).length, 0);
}

function formatTimestamp(value: number): string {
  if (!value) return "";
  return new Intl.DateTimeFormat(undefined, {
    dateStyle: "medium",
    timeStyle: "short",
  }).format(new Date(value));
}

function AgentAvatar({ agentID, small = false }: { agentID: string; small?: boolean }) {
  const meta = agentAvatarMeta(agentID);
  return (
    <span
      className={[
        "inline-flex flex-none items-center justify-center font-semibold",
        small ? "h-5 w-5 rounded-md text-micro" : "h-7 w-7 rounded-lg text-caption",
        meta.className,
      ].join(" ")}
      role="img"
      aria-label={meta.label}
    >
      {meta.initials}
    </span>
  );
}

export default function AgentSessionDetailPage() {
  const { id = "" } = useParams();
  const navigate = useNavigate();
  const tr = useT();
  // The continue box is a composer, so `/` opens the same prompt menu there.
  // This page mounts on its own route, so one read of the list is the whole
  // cost — without it the menu would claim there are no saved roles.
  const agentRoles = useAgentRoles();
  const reconnectGen = useAppStore((s) => s.reconnectGen);
  const [session, setSession] = useState<AgentSession | null>(null);
  const [items, setItems] = useState<AgentSessionHistoryItem[]>([]);
  const [prevCursor, setPrevCursor] = useState("");
  const [loading, setLoading] = useState(true);
  const [historyLoading, setHistoryLoading] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const [historyError, setHistoryError] = useState<string | null>(null);
  const [historyCut, setHistoryCut] = useState(false);
  const [attachBusy, setAttachBusy] = useState(false);
  const scrollRef = useRef<HTMLDivElement | null>(null);
  // Where the viewport was before an older page was prepended: the height
  // delta keeps the message the reader was looking at under their eyes.
  const prependAnchor = useRef<{ height: number; top: number } | null>(null);
  const scrollToEnd = useRef(false);
  const historyEvents = useMemo(
    () =>
      session
        ? agentSessionHistoryToTaskEvents(items, session.id, session.agent_id, {
            truncatedNotice: tr("agentSession.messageTruncated"),
          })
        : [],
    [items, session, tr],
  );
  const slow = useSlowHint(loading);

  const loadSession = useCallback(async () => {
    if (!isAuthenticated() || !id) return;
    setLoading(true);
    setError(null);
    setHistoryError(null);
    try {
      setSession(await getAgentSession(id));
      setItems([]);
      setPrevCursor("");
      setHistoryCut(false);
    } catch (e) {
      if (e instanceof ApiError && e.status === 401) return;
      setSession(null);
      setError(e instanceof Error ? e.message : tr("agentSession.loadFailed"));
    } finally {
      setLoading(false);
    }
  }, [id, tr]);

  const historyFailure = useCallback(
    (e: unknown) =>
      e instanceof ApiError && e.status === 501
        ? tr("agentSession.historyUnavailable")
        : e instanceof Error
          ? e.message
          : tr("agentSession.historyFailed"),
    [tr],
  );

  // Open at the end of the transcript: the newest page is what a reader wants
  // from a session they did not just watch. The second page is fetched only
  // when the budget allows it, and the budget stops at roughly 200 messages or
  // 1 MiB of text — whichever comes first — so the first screen never grows
  // with the session.
  const loadTail = useCallback(async () => {
    if (!session) return;
    setHistoryLoading(true);
    setHistoryError(null);
    try {
      const page = await getAgentSessionHistory(session.id, {
        tail: true,
        limit: HISTORY_PAGE,
      });
      let loaded = page.items;
      let prev = page.prev_cursor ?? "";
      let cut = Boolean(page.truncated) && !prev;
      if (
        prev &&
        loaded.length < HISTORY_INITIAL_MAX_ITEMS &&
        historyTextBytes(loaded) < HISTORY_INITIAL_MAX_TEXT
      ) {
        const older = await getAgentSessionHistory(session.id, {
          before: prev,
          limit: HISTORY_PAGE,
        });
        loaded = [...older.items, ...loaded];
        prev = older.prev_cursor ?? "";
        cut = Boolean(older.truncated) && !prev;
      }
      setItems(loaded);
      setPrevCursor(prev);
      setHistoryCut(cut);
      scrollToEnd.current = true;
    } catch (e) {
      if (e instanceof ApiError && e.status === 401) return;
      setHistoryError(historyFailure(e));
    } finally {
      setHistoryLoading(false);
    }
  }, [historyFailure, session]);

  const loadOlder = useCallback(async () => {
    if (!session || !prevCursor || historyLoading) return;
    const el = scrollRef.current;
    prependAnchor.current = el ? { height: el.scrollHeight, top: el.scrollTop } : null;
    setHistoryLoading(true);
    setHistoryError(null);
    try {
      const page = await getAgentSessionHistory(session.id, {
        before: prevCursor,
        limit: HISTORY_PAGE,
      });
      setItems((previous) => [...page.items, ...previous]);
      setPrevCursor(page.prev_cursor ?? "");
      if (page.truncated && !page.prev_cursor) setHistoryCut(true);
    } catch (e) {
      prependAnchor.current = null;
      if (e instanceof ApiError && e.status === 401) return;
      // Keep what the reader already has: failing to fetch an older page is
      // not a reason to take the transcript away. The top of the list offers
      // the retry instead.
      setHistoryError(historyFailure(e));
    } finally {
      setHistoryLoading(false);
    }
  }, [historyFailure, historyLoading, prevCursor, session]);

  useEffect(() => {
    void loadSession();
  }, [loadSession, reconnectGen]);

  useEffect(() => {
    if (session) void loadTail();
  }, [session, loadTail]);

  useLayoutEffect(() => {
    const el = scrollRef.current;
    if (!el) return;
    if (scrollToEnd.current) {
      scrollToEnd.current = false;
      el.scrollTop = el.scrollHeight;
      return;
    }
    const anchor = prependAnchor.current;
    if (!anchor) return;
    prependAnchor.current = null;
    el.scrollTop = anchor.top + (el.scrollHeight - anchor.height);
  }, [items]);

  const onHistoryScroll = () => {
    const el = scrollRef.current;
    if (!el || el.scrollTop > 96) return;
    void loadOlder();
  };

  const attach = async (text: string) => {
    const prompt = text.trim();
    if (!session || !prompt || attachBusy) return;
    setAttachBusy(true);
    try {
      const result = await attachAgentSession(session.id, { prompt });
      window.dispatchEvent(new Event("kin:agent-sessions-changed"));
      navigate(`/tasks/${encodeURIComponent(result.task.id)}`);
    } catch (e) {
      const message = e instanceof Error ? e.message : tr("agentSession.continueFailed");
      setHistoryError(message);
      throw new Error(message);
    } finally {
      setAttachBusy(false);
    }
  };

  if (loading) {
    return (
      <div className="flex-1 flex flex-col min-h-0 px-4 sm:px-6 py-6">
        {slow ? (
          <SlowConnectHint show />
        ) : (
          <div className="max-w-3xl space-y-3">
            <SkeletonLine className="h-6 w-56" />
            <SkeletonLine className="h-4 w-80" />
            <SkeletonLine className="h-24 w-full" />
          </div>
        )}
      </div>
    );
  }

  if (error || !session) {
    return (
      <div className="flex-1 flex flex-col items-center justify-center gap-3 px-4">
        <p className="text-strong text-kin-red-ink">{error || tr("agentSession.notFound")}</p>
        <Link to="/new" className="text-strong text-kin-blue-ink hover:underline">
          {tr("agentSession.backToChat")}
        </Link>
      </div>
    );
  }

  const agentName = agentDisplayName(session.agent_id);
  const sessionTitle = displayAgentSessionTitle(
    session,
    tr("agentSession.sessionFallback", { agent: agentName }),
  );
  const canContinue =
    !session.linked &&
    Boolean(session.cwd.trim()) &&
    session.capabilities?.includes("session_attach") === true;
  const missingContinueCwd =
    !session.linked &&
    !session.cwd.trim() &&
    session.capabilities?.includes("session_attach") === true;

  return (
    <div className="flex-1 flex flex-col min-h-0 min-w-0">
      <header className="flex-none border-b border-[var(--kin-hairline)] px-3 sm:px-5 py-3 flex items-start gap-2">
        <button
          type="button"
          /* History when there is any; a cold deep link has none, and `-1`
             there is a no-op that strands you on the screen. See AppShell's
             `closeDraft` for why `location.key` cannot answer this. */
          onClick={() => {
            if ((window.history.state?.idx ?? 0) > 0) navigate(-1);
            else navigate("/sessions");
          }}
          className="p-1.5 rounded-md text-kin-muted hover:text-kin-text hover:bg-[var(--kin-fill)]"
          aria-label={tr("agentSession.backToChat")}
        >
          <IconBack size={16} />
        </button>
        <AgentAvatar agentID={session.agent_id} />
        <div className="min-w-0 flex-1">
          <h1 className="text-subtitle font-semibold truncate text-kin-text">{sessionTitle}</h1>
          <p className="text-caption text-kin-muted truncate">
            {agentName}
            {session.project_label ? ` · ${session.project_label}` : ""}
            {session.cwd ? ` · ${session.cwd}` : ""}
          </p>
          <p className="mt-1 text-caption text-kin-muted truncate">
            {tr("agentSession.sourceId", { value: session.external_ref })}
          </p>
        </div>
        <div className="flex flex-wrap justify-end gap-1.5 max-w-[45%]">
          <span className="px-1.5 py-0.5 rounded border border-kin-hairline text-micro text-kin-muted">
            {session.status}
          </span>
          <span className="px-1.5 py-0.5 rounded border border-kin-hairline text-micro text-kin-muted">
            {session.linked
              ? tr("agentSession.connected")
              : canContinue
                ? tr("agentSession.available")
                : tr("agentSession.readOnly")}
          </span>
        </div>
      </header>

      <div className="flex-none px-4 sm:px-6 py-3 border-b border-[var(--kin-hairline)] text-caption text-kin-muted flex flex-wrap gap-x-4 gap-y-1">
        <span>{tr("agentSession.created", { value: formatTimestamp(session.first_seen_at) })}</span>
        <span>{tr("agentSession.updated", { value: formatTimestamp(session.updated_at) })}</span>
        {session.content_digest ? (
          <span>
            {tr("agentSession.sourceRevision", { value: session.content_digest.slice(0, 12) })}
          </span>
        ) : null}
        <span>{tr("agentSession.historySource")}</span>
      </div>

      {missingContinueCwd && (
        <div className="flex-none border-b border-[var(--kin-hairline)] px-4 sm:px-6 py-3 text-body text-kin-muted">
          {tr("agentSession.continueUnavailable")}
        </div>
      )}

      <div
        ref={scrollRef}
        onScroll={onHistoryScroll}
        className="flex-1 min-h-0 overflow-y-auto kin-scroll py-5"
      >
        {items.length > 0 && (
          /* The top of the transcript is where the direction changes: it says
             whether there is an older page, whether that page is being read
             now, or whether this is as far back as the session goes. */
          <div
            className="max-w-conversation mx-auto px-4 sm:px-7 pb-2 text-center text-caption text-kin-muted"
            role="status"
          >
            {historyLoading ? (
              <SkeletonLine className="h-10 w-full" />
            ) : historyError ? (
              <span className="inline-flex flex-wrap items-center justify-center gap-2">
                <span>{historyError}</span>
                <button
                  type="button"
                  onClick={() => void loadOlder()}
                  className="kin-btn-secondary"
                >
                  {tr("agentSession.historyRetry")}
                </button>
              </span>
            ) : prevCursor ? null : historyCut ? (
              tr("agentSession.historyTruncated")
            ) : (
              tr("agentSession.historyStart")
            )}
          </div>
        )}
        {historyError && items.length === 0 && (
          <div className="max-w-conversation mx-auto px-4 sm:px-7">
            <div className="rounded-lg border border-kin-orange/30 bg-kin-orange/10 px-3 py-2 text-strong text-kin-orange-ink">
              <p>{historyError}</p>
              <button
                type="button"
                onClick={() => void loadTail()}
                className="kin-btn-secondary mt-2"
              >
                {tr("agentSession.historyRetry")}
              </button>
            </div>
          </div>
        )}
        {!historyError && !historyLoading && items.length === 0 && (
          <p className="py-10 text-center text-strong text-kin-muted">
            {tr("agentSession.historyEmpty")}
          </p>
        )}
        {historyLoading && items.length === 0 && (
          <div className="max-w-conversation mx-auto px-4 sm:px-7 space-y-2 py-2" role="status">
            <SkeletonLine className="h-20 w-full" />
            <SkeletonLine className="h-16 w-5/6" />
          </div>
        )}
        <ChatStream
          events={historyEvents}
          loadingSpeaker={session.agent_id}
          hostSpeaker={session.agent_id}
        />
      </div>

      {canContinue && (
        /* `data-kin-bottom-chrome` is the same contract the conversation and
           the draft use: the shell's floating approval measures this band so
           it never covers the continue box. This page mounts only on its own
           route, so the marker needs no active-pane condition. */
        <div data-kin-bottom-chrome="" className="flex-none px-4 sm:px-7 pb-3 sm:pb-3.5 pt-1.5">
          <div className="max-w-conversation mx-auto space-y-1.5">
            <Composer
              key={session.id}
              busy={attachBusy}
              disabled={attachBusy}
              roles={agentRoles}
              placeholder={tr("agentSession.continuePlaceholder", { agent: agentName })}
              onSubmit={attach}
            />
            <div className="flex items-center gap-x-2 gap-y-1 px-0.5 min-w-0 overflow-x-auto kin-scroll">
              <CwdPicker
                className="min-w-0 max-w-inspector"
                cwd={session.cwd}
                locked
                compact
                onChange={() => undefined}
              />
              <span className="text-kin-muted/50 flex-none select-none" aria-hidden>
                ·
              </span>
              <BranchPicker
                cwd={session.cwd}
                // The session's directory is on the machine that owns it, so
                // the branches are that machine's. Without this the chip reads
                // this machine's checkout of the same path — the same trap the
                // task strip avoids, and silent rather than wrong-looking.
                device={session.device_id}
                locked
                compact
                className="flex-none"
              />
            </div>
          </div>
        </div>
      )}
    </div>
  );
}
