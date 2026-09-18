import { useCallback, useEffect, useState } from "react";
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
import { IconBack } from "../components/icons";
import { SkeletonLine, SlowConnectHint } from "../components/Skeleton";
import { useSlowHint } from "../hooks/useSlowHint";
import { useT } from "../i18n/react";
import { useAppStore } from "../store/appStore";

function formatTimestamp(value: number): string {
  if (!value) return "";
  return new Intl.DateTimeFormat(undefined, {
    dateStyle: "medium",
    timeStyle: "short",
  }).format(new Date(value));
}

function roleLabel(role: AgentSessionHistoryItem["role"], tr: ReturnType<typeof useT>): string {
  return role === "user"
    ? tr("agentSession.user")
    : tr("agentSession.assistant");
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
  const [attachPrompt, setAttachPrompt] = useState("");
  const [attachBusy, setAttachBusy] = useState(false);
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
      } finally {
        setHistoryLoading(false);
      }
    },
    [session, tr],
  );

  useEffect(() => {
    void loadSession();
  }, [loadSession, reconnectGen]);

  useEffect(() => {
    if (session) void loadHistory();
  }, [session, loadHistory]);

  const attach = async () => {
    const prompt = attachPrompt.trim();
    if (!session || !prompt || attachBusy) return;
    setAttachBusy(true);
    try {
      const result = await attachAgentSession(session.id, { prompt });
      window.dispatchEvent(new Event("kin:agent-sessions-changed"));
      navigate(`/tasks/${encodeURIComponent(result.task.id)}`);
    } catch (e) {
      setError(e instanceof Error ? e.message : tr("agentSession.attachFailed"));
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
        <div className="min-w-0 flex-1">
          <h1 className="text-[15px] font-semibold truncate text-kin-text">
            {session.title || session.external_ref}
          </h1>
          <p className="text-[11.5px] text-kin-muted truncate">
            {session.agent_id}
            {session.project_label ? ` · ${session.project_label}` : ""}
            {session.cwd ? ` · ${session.cwd}` : ""}
          </p>
          <p className="mt-1 text-[11px] text-kin-muted truncate">
            {session.external_ref}
          </p>
        </div>
        <div className="flex flex-wrap justify-end gap-1.5 max-w-[45%]">
          <span className="px-1.5 py-0.5 rounded border border-kin-border text-[10px] text-kin-muted">
            {session.status}
          </span>
          <span className="px-1.5 py-0.5 rounded border border-kin-border text-[10px] text-kin-muted">
            {session.linked
              ? tr("agentSession.attached")
              : tr("agentSession.unlinked")}
          </span>
          {!session.linked && (
            <span className="px-1.5 py-0.5 rounded border border-kin-border text-[10px] text-kin-muted">
              {tr("agentSession.readOnly")}
            </span>
          )}
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

      {!session.linked &&
        session.capabilities?.includes("session_attach") && (
          <div className="flex-none border-b border-[var(--kin-hairline)] px-4 sm:px-6 py-3">
            <div className="max-w-3xl mx-auto flex flex-col sm:flex-row gap-2">
              <input
                value={attachPrompt}
                onChange={(e) => setAttachPrompt(e.target.value)}
                onKeyDown={(e) => {
                  if (e.key === "Enter" && (e.metaKey || e.ctrlKey)) void attach();
                }}
                placeholder={tr("agentSession.attachPlaceholder")}
                aria-label={tr("agentSession.attachPrompt")}
                className="kin-input min-h-[40px] flex-1"
              />
              <button
                type="button"
                disabled={attachBusy || !attachPrompt.trim()}
                onClick={() => void attach()}
                className="kin-btn-primary disabled:opacity-50"
              >
                {attachBusy
                  ? tr("agentSession.attaching")
                  : tr("agentSession.attach")}
              </button>
            </div>
          </div>
        )}

      <div className="flex-1 min-h-0 overflow-y-auto kin-scroll px-3 sm:px-6 py-5">
        <div className="max-w-3xl mx-auto space-y-4">
          {historyError && (
            <div className="rounded-lg border border-kin-orange/30 bg-kin-orange/10 px-3 py-2 text-[13px] text-kin-orange">
              {historyError}
            </div>
          )}
          {!historyError && !historyLoading && items.length === 0 && (
            <p className="py-10 text-center text-[13px] text-kin-muted">
              {tr("agentSession.historyEmpty")}
            </p>
          )}
          {items.map((item) => (
            <article
              key={`${item.message_id}:${item.source_rev}`}
              className="rounded-lg border border-[var(--kin-hairline)] bg-kin-elevated/60 px-4 py-3"
            >
              <div className="flex items-center justify-between gap-3 mb-2">
                <span className="text-[11px] font-semibold uppercase tracking-wide text-kin-muted">
                  {roleLabel(item.role, tr)}
                </span>
                <span className="text-[10.5px] text-kin-muted">
                  {formatTimestamp(item.occurred_at)}
                </span>
              </div>
              <p className="text-[13.5px] leading-6 text-kin-text whitespace-pre-wrap break-words">
                {item.text}
              </p>
            </article>
          ))}
          {historyLoading && (
            <div className="space-y-2 py-2" role="status">
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
      </div>
    </div>
  );
}
