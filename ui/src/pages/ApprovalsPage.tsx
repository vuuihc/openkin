import { useCallback, useEffect, useState } from "react";
import { Link } from "react-router-dom";
import {
  ApiError,
  connectWS,
  decideApproval,
  getToken,
  listApprovals,
  parseApprovalPayload,
  type Approval,
} from "../api/client";

export default function ApprovalsPage() {
  const [items, setItems] = useState<Approval[]>([]);
  const [loading, setLoading] = useState(true);
  const [error, setError] = useState<string | null>(null);
  const [busy, setBusy] = useState<Record<string, "approved" | "denied">>({});

  const load = useCallback(async () => {
    if (!getToken()) {
      setError("No auth token. Open the URL printed by `kin serve`.");
      setLoading(false);
      return;
    }
    try {
      const list = await listApprovals("pending");
      setItems(list);
      setError(null);
    } catch (e) {
      if (e instanceof ApiError && e.status === 401) {
        setError("Unauthorized");
      } else {
        setError(e instanceof Error ? e.message : "Failed to load");
      }
    } finally {
      setLoading(false);
    }
  }, []);

  useEffect(() => {
    void load();
  }, [load]);

  useEffect(() => {
    return connectWS((msg) => {
      if (msg.kind !== "approval_update") return;
      const a = msg.data;
      setItems((prev) => {
        if (a.decision !== "pending") {
          return prev.filter((x) => x.id !== a.id);
        }
        const rest = prev.filter((x) => x.id !== a.id);
        return [a, ...rest].sort((x, y) => y.created_at - x.created_at);
      });
    });
  }, []);

  async function onDecide(id: string, decision: "approved" | "denied") {
    setBusy((b) => ({ ...b, [id]: decision }));
    // Optimistic remove.
    setItems((prev) => prev.filter((x) => x.id !== id));
    try {
      await decideApproval(id, decision);
    } catch (e) {
      setError(e instanceof Error ? e.message : "Decision failed");
      void load();
    } finally {
      setBusy((b) => {
        const next = { ...b };
        delete next[id];
        return next;
      });
    }
  }

  if (loading) {
    return (
      <p className="text-sm text-zinc-400" role="status">
        Loading approvals…
      </p>
    );
  }

  return (
    <div className="space-y-4">
      <div className="flex items-baseline justify-between gap-3">
        <h1 className="text-xl font-semibold text-zinc-50">Approvals</h1>
        {items.length > 0 && (
          <span className="text-xs text-amber-400/90">{items.length} pending</span>
        )}
      </div>

      {error && (
        <div
          className="rounded-xl border border-red-900/60 bg-red-950/40 px-4 py-3 text-sm text-red-200"
          role="alert"
        >
          {error}
        </div>
      )}

      {items.length === 0 ? (
        <div className="rounded-xl border border-dashed border-surface-border bg-surface-raised/40 px-6 py-16 text-center">
          <p className="text-base font-medium text-zinc-200">No pending approvals</p>
          <p className="mt-1 text-sm text-zinc-500">
            When an agent needs permission, the request shows up here for one-tap
            approve or deny.
          </p>
        </div>
      ) : (
        <ul className="space-y-4">
          {items.map((a) => (
            <li key={a.id}>
              <ApprovalCard
                approval={a}
                busy={busy[a.id]}
                onApprove={() => void onDecide(a.id, "approved")}
                onDeny={() => void onDecide(a.id, "denied")}
              />
            </li>
          ))}
        </ul>
      )}
    </div>
  );
}

function ApprovalCard({
  approval,
  busy,
  onApprove,
  onDeny,
}: {
  approval: Approval;
  busy?: "approved" | "denied";
  onApprove: () => void;
  onDeny: () => void;
}) {
  const { toolName, input } = parseApprovalPayload(approval.payload);
  const highlightKeys = ["file_path", "command", "content", "path", "file"];
  const highlights = highlightKeys
    .filter((k) => input[k] != null && input[k] !== "")
    .map((k) => ({ key: k, value: input[k] }));

  return (
    <article className="rounded-2xl border border-amber-900/40 bg-surface-raised shadow-lg shadow-black/20 overflow-hidden">
      <div className="border-b border-surface-border px-4 py-3 flex flex-wrap items-start justify-between gap-2">
        <div className="min-w-0">
          <p className="text-[10px] uppercase tracking-wider text-amber-500/90 font-medium">
            Permission request
          </p>
          <h2 className="mt-0.5 font-mono text-base text-zinc-50 break-all">{toolName}</h2>
          {approval.task_title && (
            <Link
              to={`/tasks/${approval.task_id}`}
              className="mt-1 inline-block text-sm text-accent hover:underline truncate max-w-full"
            >
              {approval.task_title}
            </Link>
          )}
          {approval.task_agent && (
            <span className="ml-2 text-xs text-zinc-500">{approval.task_agent}</span>
          )}
        </div>
        <span className="text-[10px] text-zinc-500 font-mono shrink-0">
          {new Date(approval.created_at).toLocaleTimeString()}
        </span>
      </div>

      <div className="px-4 py-3 space-y-3">
        {highlights.map(({ key, value }) => (
          <div key={key}>
            <div className="text-[10px] uppercase tracking-wide text-zinc-500 mb-1">{key}</div>
            <HighlightValue value={value} />
          </div>
        ))}

        <details className="group">
          <summary className="cursor-pointer text-xs text-zinc-500 hover:text-zinc-300 select-none">
            Full input JSON
          </summary>
          <pre className="mt-2 overflow-x-auto rounded-lg bg-black/40 border border-surface-border p-3 text-xs font-mono text-zinc-300 max-h-64">
            {JSON.stringify(input, null, 2)}
          </pre>
        </details>
      </div>

      <div className="flex gap-3 p-4 pt-0">
        <button
          type="button"
          onClick={onDeny}
          disabled={!!busy}
          className="flex-1 min-h-[48px] rounded-xl border border-red-800/70 bg-red-950/40 text-base font-semibold text-red-200 active:scale-[0.98] hover:bg-red-950/70 disabled:opacity-50 transition"
        >
          {busy === "denied" ? "Denying…" : "Deny"}
        </button>
        <button
          type="button"
          onClick={onApprove}
          disabled={!!busy}
          className="flex-1 min-h-[48px] rounded-xl border border-emerald-700/70 bg-emerald-600 text-base font-semibold text-white active:scale-[0.98] hover:bg-emerald-500 disabled:opacity-50 transition shadow-md shadow-emerald-950/40"
        >
          {busy === "approved" ? "Approving…" : "Approve"}
        </button>
      </div>
    </article>
  );
}

function HighlightValue({ value }: { value: unknown }) {
  const text = typeof value === "string" ? value : JSON.stringify(value, null, 2);
  if (looksLikeDiff(text)) {
    return <DiffView text={text} />;
  }
  return (
    <pre className="overflow-x-auto rounded-lg bg-black/30 border border-surface-border p-3 text-sm font-mono text-zinc-200 whitespace-pre-wrap break-words max-h-48">
      {text}
    </pre>
  );
}

function looksLikeDiff(s: string): boolean {
  if (!s.includes("\n")) return false;
  const lines = s.split("\n");
  let plus = 0;
  let minus = 0;
  let headers = 0;
  for (const line of lines.slice(0, 40)) {
    if (line.startsWith("+++") || line.startsWith("---") || line.startsWith("@@")) headers++;
    else if (line.startsWith("+")) plus++;
    else if (line.startsWith("-")) minus++;
  }
  return headers >= 1 || (plus + minus >= 3 && plus > 0 && minus > 0);
}

function DiffView({ text }: { text: string }) {
  return (
    <pre className="overflow-x-auto rounded-lg bg-black/40 border border-surface-border p-3 text-xs font-mono max-h-56 leading-relaxed">
      {text.split("\n").map((line, i) => {
        let cls = "text-zinc-400";
        if (line.startsWith("+") && !line.startsWith("+++")) cls = "text-emerald-400";
        else if (line.startsWith("-") && !line.startsWith("---")) cls = "text-red-400";
        else if (line.startsWith("@@")) cls = "text-sky-400";
        else if (line.startsWith("+++") || line.startsWith("---")) cls = "text-zinc-300 font-semibold";
        return (
          <div key={i} className={cls}>
            {line || " "}
          </div>
        );
      })}
    </pre>
  );
}
