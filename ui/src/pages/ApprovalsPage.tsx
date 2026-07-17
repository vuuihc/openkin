import { useCallback, useEffect, useState } from "react";
import {
  ApiError,
  decideApproval,
  getToken,
  listApprovals,
  type Approval,
} from "../api/client";
import ApprovalCard from "../components/cards/ApprovalCard";
import RunningTaskCard from "../components/cards/RunningTaskCard";
import {
  ApprovalListSkeleton,
  SlowConnectHint,
} from "../components/Skeleton";
import { useSlowHint } from "../hooks/useSlowHint";
import { subscribeWS, useAppStore } from "../store/appStore";
import { listTasks, type Task, isTerminal } from "../api/client";
import { Link, useSearchParams } from "react-router-dom";
import { useT } from "../i18n/react";

type PendingDecision = "approved" | "denied";

/**
 * Inbox — design 3g. Pending approvals first; running tasks below.
 */
export default function ApprovalsPage() {
  const tr = useT();
  const [items, setItems] = useState<Approval[]>([]);
  const [running, setRunning] = useState<Task[]>([]);
  const [loading, setLoading] = useState(true);
  const [error, setError] = useState<string | null>(null);
  const [busy, setBusy] = useState<Record<string, PendingDecision>>({});
  const [focusIdx, setFocusIdx] = useState(0);
  const pushToast = useAppStore((s) => s.pushToast);
  const reconnectGen = useAppStore((s) => s.reconnectGen);
  const slow = useSlowHint(loading);
  const [searchParams] = useSearchParams();
  const focusId = searchParams.get("focus");

  const load = useCallback(async () => {
    if (!getToken()) return;
    try {
      const [list, tasks] = await Promise.all([
        listApprovals("pending"),
        listTasks({ limit: 50 }),
      ]);
      setItems(list);
      setRunning(tasks.filter((t) => !isTerminal(t.status)));
      setError(null);
    } catch (e) {
      if (e instanceof ApiError && e.status === 401) return;
      setError(e instanceof Error ? e.message : tr("inbox.loadFailed"));
    } finally {
      setLoading(false);
    }
  }, [tr]);

  useEffect(() => {
    setLoading(true);
    void load();
  }, [load]);

  useEffect(() => {
    if (reconnectGen === 0) return;
    void load();
  }, [reconnectGen, load]);

  useEffect(() => {
    return subscribeWS((msg) => {
      if (msg.kind === "approval_update") {
        const a = msg.data as Approval;
        setItems((prev) => {
          if (a.decision !== "pending") {
            setBusy((b) => {
              if (!(a.id in b)) return b;
              const next = { ...b };
              delete next[a.id];
              return next;
            });
            return prev.filter((x) => x.id !== a.id);
          }
          const rest = prev.filter((x) => x.id !== a.id);
          return [a, ...rest].sort((x, y) => y.created_at - x.created_at);
        });
      }
      if (msg.kind === "task_update") {
        const t = msg.data as Task;
        setRunning((prev) => {
          const rest = prev.filter((x) => x.id !== t.id);
          if (isTerminal(t.status)) return rest;
          return [t, ...rest];
        });
      }
    });
  }, []);

  useEffect(() => {
    if (!focusId || !items.length) return;
    const i = items.findIndex((a) => a.id === focusId);
    if (i >= 0) setFocusIdx(i);
  }, [focusId, items]);

  useEffect(() => {
    function onKey(e: KeyboardEvent) {
      if (e.target instanceof HTMLInputElement || e.target instanceof HTMLTextAreaElement) {
        return;
      }
      if (!items.length) return;
      if (e.key === "j" || e.key === "J") setFocusIdx((i) => Math.min(items.length - 1, i + 1));
      else if (e.key === "k" || e.key === "K") setFocusIdx((i) => Math.max(0, i - 1));
      else if (e.key === "a" || e.key === "A") {
        const a = items[focusIdx] ?? items[0];
        if (a) void onDecide(a.id, "approved");
      } else if (e.key === "d" || e.key === "D") {
        const a = items[focusIdx] ?? items[0];
        if (a) void onDecide(a.id, "denied");
      }
    }
    window.addEventListener("keydown", onKey);
    return () => window.removeEventListener("keydown", onKey);
  }, [items, focusIdx]);

  async function onDecide(id: string, decision: PendingDecision) {
    setBusy((b) => ({ ...b, [id]: decision }));
    try {
      await decideApproval(id, decision);
      setItems((prev) => prev.filter((x) => x.id !== id));
      setBusy((b) => {
        const next = { ...b };
        delete next[id];
        return next;
      });
    } catch (e) {
      setBusy((b) => {
        const next = { ...b };
        delete next[id];
        return next;
      });
      pushToast(e instanceof Error ? e.message : tr("inbox.decisionFailed"), "error");
      void load();
    }
  }

  return (
    <div className="flex-1 overflow-y-auto kin-scroll">
      <div className="max-w-[640px] mx-auto px-4 sm:px-6 py-6 sm:py-8">
        <h1 className="text-[28px] sm:text-[32px] font-bold tracking-tight">
          {tr("inbox.title")}
        </h1>
        <p className="text-[13.5px] text-kin-tertiary mt-1">
          {loading
            ? tr("inbox.loading")
            : items.length === 0
              ? tr("inbox.noneWaiting")
              : tr("inbox.waiting", { count: items.length })}
        </p>

        {loading && (
          <div className="mt-6 space-y-3">
            <SlowConnectHint show={slow} />
            <ApprovalListSkeleton />
          </div>
        )}

        {!loading && error && (
          <div
            className="mt-6 rounded-xl border border-kin-red/40 bg-[rgba(255,69,58,.08)] px-4 py-3 text-sm text-[#ff8a80]"
            role="alert"
          >
            {error}
          </div>
        )}

        {!loading && !error && items.length === 0 && running.length === 0 && (
          <div className="mt-10 rounded-2xl border border-dashed border-[var(--kin-hairline-strong)] px-6 py-16 text-center">
            <p className="text-base font-medium text-kin-text">{tr("inbox.allClear")}</p>
            <p className="mt-1 text-sm text-kin-secondary">
              {tr("inbox.allClearHint")}
            </p>
          </div>
        )}

        {!loading && items.length > 0 && (
          <ul className="mt-6 space-y-3.5">
            {items.map((a, i) => (
              <li key={a.id}>
                <ApprovalCard
                  approval={a}
                  focused={i === focusIdx}
                  busy={busy[a.id] ?? null}
                  onApprove={() => void onDecide(a.id, "approved")}
                  onDeny={() => void onDecide(a.id, "denied")}
                />
              </li>
            ))}
          </ul>
        )}

        {!loading && running.length > 0 && (
          <div className="mt-10">
            <div className="text-[11px] font-semibold uppercase tracking-wide text-kin-muted mb-3">
              {tr("inbox.running")}
            </div>
            <ul className="space-y-2.5">
              {running.map((t) => (
                <li key={t.id}>
                  <Link to={`/tasks/${t.id}`} className="block">
                    <RunningTaskCard task={t} />
                  </Link>
                </li>
              ))}
            </ul>
          </div>
        )}
      </div>
    </div>
  );
}
