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
import { IconBack } from "../components/icons";
import Markdown from "../components/Markdown";
import { SkeletonLine, SlowConnectHint } from "../components/Skeleton";
import { useSlowHint } from "../hooks/useSlowHint";
import { useT } from "../i18n/react";
import { useAppStore } from "../store/appStore";
import {
  groupAgentSessionHistory,
  mergeAgentSessionMessageChunks,
  type AgentSessionTurn,
} from "../lib/agentSessionHistory";

function formatTimestamp(value: number): string {
  if (!value) return "";
  return new Intl.DateTimeFormat(undefined, {
    dateStyle: "medium",
    timeStyle: "short",
  }).format(new Date(value));
}

function roleLabel(role: AgentSessionHistoryItem["role"], tr: ReturnType<typeof useT>): string {
  if (role === "user") return tr("agentSession.user");
  if (role === "tool") return tr("agentSession.tool");
  return tr("agentSession.assistant");
}

function historyItemKey(item: AgentSessionHistoryItem): string {
  return `${item.kind ?? "message"}:${item.message_id}:${item.source_rev}`;
}

function UserMessage({
  item,
  tr,
}: {
  item: AgentSessionHistoryItem;
  tr: ReturnType<typeof useT>;
}) {
  return (
    <div className="flex justify-end">
      <article className="max-w-[88%] rounded-xl bg-kin-blue-soft px-4 py-3 text-kin-text">
        <div className="flex items-center gap-3 mb-1.5">
          <span className="text-[10.5px] font-semibold uppercase tracking-wide text-kin-muted">
            {roleLabel(item.role, tr)}
          </span>
          <span className="text-[10px] text-kin-muted">
            {formatTimestamp(item.occurred_at)}
          </span>
        </div>
        <p className="text-[13.5px] leading-6 whitespace-pre-wrap break-words">{item.text}</p>
      </article>
    </div>
  );
}

function AssistantConclusion({
  item,
  tr,
  provisional = false,
}: {
  item: AgentSessionHistoryItem;
  tr: ReturnType<typeof useT>;
  provisional?: boolean;
}) {
  return (
    <div className="flex justify-start">
      <article className="max-w-[92%] rounded-xl border border-[var(--kin-hairline)] bg-kin-elevated/70 px-4 py-3 text-kin-text">
        <div className="flex items-center gap-3 mb-2">
          <span className="text-[10.5px] font-semibold uppercase tracking-wide text-kin-muted">
            {provisional
              ? tr("agentSession.assistant")
              : tr("agentSession.finalOutput")}
          </span>
          <span className="text-[10px] text-kin-muted">
            {formatTimestamp(item.occurred_at)}
          </span>
        </div>
        <Markdown text={item.text} className="text-[13.5px] sm:text-[14px]" />
      </article>
    </div>
  );
}

function ProcessEvent({
  item,
  tr,
}: {
  item: AgentSessionHistoryItem;
  tr: ReturnType<typeof useT>;
}) {
  const kind = item.kind ?? "message";
  if (kind === "tool_call" || kind === "tool_result") {
    return (
      <div
        className="rounded-md border border-[var(--kin-hairline)] bg-[var(--kin-fill)] px-3 py-2 text-[12px] text-kin-muted"
      >
        <div className="flex items-center gap-2">
          <span className="font-medium text-kin-secondary">
            {kind === "tool_call"
              ? tr("agentSession.toolCall")
              : tr("agentSession.toolResult")}
          </span>
          {item.tool_name ? (
            <code className="text-[11px] text-kin-text">{item.tool_name}</code>
          ) : null}
          <span className="ml-auto text-[10px]">
            {formatTimestamp(item.occurred_at)}
          </span>
        </div>
        <pre className="mt-2 max-h-64 overflow-auto whitespace-pre-wrap break-words rounded bg-black/5 p-2 text-[11px] leading-5">
          {item.text}
        </pre>
      </div>
    );
  }
  if (kind === "reasoning") {
    return (
      <div className="rounded-md border border-dashed border-[var(--kin-hairline)] px-3 py-2 text-[12px] text-kin-muted">
        <div className="flex items-center gap-2">
          <span className="font-medium text-kin-secondary">
            {tr("agentSession.reasoning")}
          </span>
          <span className="ml-auto text-[10px]">
            {formatTimestamp(item.occurred_at)}
          </span>
        </div>
        <p className="mt-2 whitespace-pre-wrap break-words leading-5">{item.text}</p>
      </div>
    );
  }
  return (
    <div className="rounded-md border border-[var(--kin-hairline)] px-3 py-2 text-[12px] text-kin-muted">
      <div className="flex items-center gap-2">
        <span className="font-medium text-kin-secondary">
          {tr("agentSession.progress")}
        </span>
        <span className="ml-auto text-[10px]">
          {formatTimestamp(item.occurred_at)}
        </span>
      </div>
      <p className="mt-2 whitespace-pre-wrap break-words leading-5">{item.text}</p>
    </div>
  );
}

function HistoryTurnView({
  turn,
  tr,
  provisionalFinal = false,
}: {
  turn: AgentSessionTurn;
  tr: ReturnType<typeof useT>;
  provisionalFinal?: boolean;
}) {
  return (
    <section className="space-y-3">
      {turn.userItems.map((item) => (
        <UserMessage key={historyItemKey(item)} item={item} tr={tr} />
      ))}
      {turn.processItems.length > 0 ? (
        <details className="rounded-lg border border-[var(--kin-hairline)] bg-[var(--kin-fill)]/45">
          <summary className="cursor-pointer select-none px-3 py-2 text-[12px] text-kin-muted">
            <span className="font-medium text-kin-secondary">
              {tr("agentSession.process", { count: turn.processItems.length })}
            </span>
          </summary>
          <div className="space-y-2 border-t border-[var(--kin-hairline)] p-2.5">
            {turn.processItems.map((item) => (
              <ProcessEvent key={historyItemKey(item)} item={item} tr={tr} />
            ))}
          </div>
        </details>
      ) : null}
      {turn.finalAssistant ? (
        <AssistantConclusion
          item={turn.finalAssistant}
          tr={tr}
          provisional={provisionalFinal}
        />
      ) : null}
    </section>
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
  const [attachPrompt, setAttachPrompt] = useState("");
  const [attachBusy, setAttachBusy] = useState(false);
  const displayTurns = useMemo(
    () => groupAgentSessionHistory(mergeAgentSessionMessageChunks(items)),
    [items],
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
          {displayTurns.map((turn, index) => (
            <HistoryTurnView
              key={turn.id}
              turn={turn}
              tr={tr}
              provisionalFinal={Boolean(nextCursor) && index === displayTurns.length - 1}
            />
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
