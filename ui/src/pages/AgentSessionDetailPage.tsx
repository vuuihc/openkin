import { useCallback, useEffect, useMemo, useState } from "react";
import { Link, useNavigate, useParams } from "react-router-dom";
import {
  ApiError,
  attachAgentSession,
  getAgentSession,
  getAgentSessionHistory,
  getToken,
  type AgentSession,
  type AgentSessionHistoryItem,
} from "../api/client";
import ChatStream from "../components/chat/ChatStream";
import BranchPicker from "../components/chat/BranchPicker";
import Composer from "../components/chat/Composer";
import CwdPicker from "../components/chat/CwdPicker";
import { IconBack } from "../components/icons";
import { SkeletonLine, SlowConnectHint } from "../components/Skeleton";
import { useSlowHint } from "../hooks/useSlowHint";
import { useT } from "../i18n/react";
import { agentAvatarMeta, agentDisplayName } from "../lib/agentMention";
import { displayAgentSessionTitle } from "../lib/agentSessionTitle";
import { useAppStore } from "../store/appStore";
import { agentSessionHistoryToTaskEvents } from "../lib/agentSessionHistory";

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
        small ? "h-5 w-5 rounded-[6px] text-[9px]" : "h-7 w-7 rounded-[8px] text-[11px]",
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
  const reconnectGen = useAppStore((s) => s.reconnectGen);
  const [session, setSession] = useState<AgentSession | null>(null);
  const [items, setItems] = useState<AgentSessionHistoryItem[]>([]);
  const [nextCursor, setNextCursor] = useState("");
  const [loading, setLoading] = useState(true);
  const [historyLoading, setHistoryLoading] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const [historyError, setHistoryError] = useState<string | null>(null);
  const [attachBusy, setAttachBusy] = useState(false);
  const historyEvents = useMemo(
    () =>
      session
        ? agentSessionHistoryToTaskEvents(items, session.id, session.agent_id)
        : [],
    [items, session],
  );
  const slow = useSlowHint(loading);

  const loadSession = useCallback(async () => {
    if (!getToken() || !id) return;
    setLoading(true);
    setError(null);
    setHistoryError(null);
    try {
      setSession(await getAgentSession(id));
      setItems([]);
      setNextCursor("");
    } catch (e) {
      if (e instanceof ApiError && e.status === 401) return;
      setSession(null);
      setError(e instanceof Error ? e.message : tr("agentSession.loadFailed"));
    } finally {
      setLoading(false);
    }
  }, [id, tr]);

  const loadHistory = useCallback(
    async (cursor = "") => {
      if (!session) return;
      setHistoryLoading(true);
      setHistoryError(null);
      try {
        const page = await getAgentSessionHistory(session.id, {
          cursor: cursor || undefined,
          limit: 50,
        });
        setItems((previous) => (cursor ? [...previous, ...page.items] : page.items));
        setNextCursor(page.next_cursor ?? "");
      } catch (e) {
        if (e instanceof ApiError && e.status === 401) return;
        setHistoryError(
          e instanceof ApiError && e.status === 501
            ? tr("agentSession.historyUnavailable")
            : e instanceof Error
              ? e.message
              : tr("agentSession.historyFailed"),
        );
        if (cursor) {
          setItems([]);
          setNextCursor("");
          void loadSession();
        }
      } finally {
        setHistoryLoading(false);
      }
    },
    [loadSession, session, tr],
  );

  useEffect(() => {
    void loadSession();
  }, [loadSession, reconnectGen]);

  useEffect(() => {
    if (session) void loadHistory();
  }, [session, loadHistory]);

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
        <p className="text-[14px] text-kin-red">{error || tr("agentSession.notFound")}</p>
        <Link to="/new" className="text-[13px] text-kin-blue hover:underline">
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
          onClick={() => navigate(-1)}
          className="p-1.5 rounded-md text-kin-muted hover:text-kin-text hover:bg-[var(--kin-fill)]"
          aria-label={tr("agentSession.backToChat")}
        >
          <IconBack size={16} />
        </button>
        <AgentAvatar agentID={session.agent_id} />
        <div className="min-w-0 flex-1">
          <h1 className="text-[15px] font-semibold truncate text-kin-text">
            {sessionTitle}
          </h1>
          <p className="text-[11.5px] text-kin-muted truncate">
            {agentName}
            {session.project_label ? ` · ${session.project_label}` : ""}
            {session.cwd ? ` · ${session.cwd}` : ""}
          </p>
          <p className="mt-1 text-[11px] text-kin-muted truncate">
            {tr("agentSession.sourceId", { value: session.external_ref })}
          </p>
        </div>
        <div className="flex flex-wrap justify-end gap-1.5 max-w-[45%]">
          <span className="px-1.5 py-0.5 rounded border border-kin-border text-[10px] text-kin-muted">
            {session.status}
          </span>
          <span className="px-1.5 py-0.5 rounded border border-kin-border text-[10px] text-kin-muted">
            {session.linked
              ? tr("agentSession.connected")
              : canContinue
                ? tr("agentSession.available")
                : tr("agentSession.readOnly")}
          </span>
        </div>
      </header>

      <div className="flex-none px-4 sm:px-6 py-3 border-b border-[var(--kin-hairline)] text-[11.5px] text-kin-muted flex flex-wrap gap-x-4 gap-y-1">
        <span>{tr("agentSession.created", { value: formatTimestamp(session.first_seen_at) })}</span>
        <span>{tr("agentSession.updated", { value: formatTimestamp(session.updated_at) })}</span>
        {session.content_digest ? (
          <span>{tr("agentSession.sourceRevision", { value: session.content_digest.slice(0, 12) })}</span>
        ) : null}
        <span>{tr("agentSession.historySource")}</span>
      </div>

      {missingContinueCwd && (
        <div className="flex-none border-b border-[var(--kin-hairline)] px-4 sm:px-6 py-3 text-[12px] text-kin-muted">
          {tr("agentSession.continueUnavailable")}
        </div>
      )}

      <div className="flex-1 min-h-0 overflow-y-auto kin-scroll py-5">
        {historyError && (
          <div className="max-w-[720px] mx-auto px-4 sm:px-7">
            <div className="rounded-lg border border-kin-orange/30 bg-kin-orange/10 px-3 py-2 text-[13px] text-kin-orange">
              {historyError}
            </div>
          </div>
        )}
        {!historyError && !historyLoading && items.length === 0 && (
          <p className="py-10 text-center text-[13px] text-kin-muted">
            {tr("agentSession.historyEmpty")}
          </p>
        )}
        <ChatStream
          events={historyEvents}
          loadingSpeaker={session.agent_id}
          hostSpeaker={session.agent_id}
        />
        {historyLoading && (
          <div className="max-w-[720px] mx-auto px-4 sm:px-7 space-y-2 py-2" role="status">
            <SkeletonLine className="h-20 w-full" />
            <SkeletonLine className="h-16 w-5/6" />
          </div>
        )}
        {!historyLoading && nextCursor && (
          <div className="flex justify-center pt-2">
            <button
              type="button"
              onClick={() => void loadHistory(nextCursor)}
              className="kin-btn-secondary"
            >
              {tr("agentSession.loadMore")}
            </button>
          </div>
        )}
      </div>

      {canContinue && (
        <div className="flex-none px-4 sm:px-7 pb-3 sm:pb-3.5 pt-1.5">
          <div className="max-w-[720px] mx-auto space-y-1.5">
            <Composer
              key={session.id}
              busy={attachBusy}
              disabled={attachBusy}
              placeholder={tr("agentSession.continuePlaceholder", { agent: agentName })}
              onSubmit={attach}
            />
            <div className="flex items-center gap-x-2 gap-y-1 px-0.5 min-w-0 overflow-x-auto kin-scroll">
              <CwdPicker
                className="min-w-0 max-w-[min(40%,18rem)]"
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
