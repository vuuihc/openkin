import { useMemo, useState } from "react";
import type { TaskEvent } from "../api/client";
import Markdown from "./Markdown";

type Props = {
  events: TaskEvent[];
};

type Row =
  | { kind: "text"; role: string; text: string; partial?: boolean; key: string }
  | { kind: "tool"; name: string; input: unknown; key: string }
  | { kind: "raw"; line: string; key: string }
  | { kind: "error"; message: string; key: string }
  | { kind: "result"; payload: Record<string, unknown>; key: string }
  | { kind: "meta"; label: string; key: string }
  | { kind: "approval_req"; tool: string; approvalId: string; key: string }
  | { kind: "approval_dec"; decision: string; via: string; key: string };

export default function Transcript({ events }: Props) {
  const rows = useMemo(() => buildRows(events), [events]);

  if (rows.length === 0) {
    return (
      <p className="text-sm text-zinc-500" role="status">
        Waiting for events…
      </p>
    );
  }

  return (
    <div className="space-y-3">
      {rows.map((row) => {
        switch (row.kind) {
          case "text":
            return (
              <div
                key={row.key}
                className={`rounded-xl border px-4 py-3 ${
                  row.role === "user"
                    ? "border-[var(--kin-hairline)] bg-[var(--kin-fill)]"
                    : "border-[var(--kin-hairline)] bg-kin-elevated"
                }`}
              >
                <div className="mb-1 text-[10px] uppercase tracking-wide text-kin-muted">
                  {row.role}
                  {row.partial ? " · streaming" : ""}
                </div>
                <Markdown text={row.text} />
              </div>
            );
          case "tool":
            return <ToolBlock key={row.key} name={row.name} input={row.input} />;
          case "raw":
            return (
              <pre
                key={row.key}
                className="overflow-x-auto rounded-lg bg-[var(--kin-fill)] border border-[var(--kin-hairline)] p-2 text-[11px] font-mono text-kin-secondary"
              >
                {row.line}
              </pre>
            );
          case "error":
            return (
              <div
                key={row.key}
                className="rounded-xl border border-kin-red/30 bg-[rgba(255,69,58,.08)] px-4 py-3 text-sm text-kin-red"
              >
                {row.message}
              </div>
            );
          case "result":
            return (
              <div
                key={row.key}
                className="rounded-xl border border-kin-green/30 bg-[rgba(48,209,88,.08)] px-4 py-3 text-xs text-kin-secondary"
              >
                Result · cost{" "}
                {typeof row.payload.cost_usd === "number"
                  ? `$${row.payload.cost_usd}`
                  : "—"}
              </div>
            );
          case "meta":
            return (
              <p key={row.key} className="text-xs text-zinc-500">
                {row.label}
              </p>
            );
          case "approval_req":
            return (
              <div
                key={row.key}
                className="rounded-xl border border-amber-900/50 bg-amber-950/30 px-4 py-3 text-sm"
              >
                <span className="text-amber-300 font-medium">Approval requested</span>
                <span className="text-zinc-400">
                  {" "}
                  · {row.tool || "tool"}
                  {row.approvalId ? (
                    <span className="font-mono text-xs text-zinc-500"> · {row.approvalId.slice(0, 10)}…</span>
                  ) : null}
                </span>
              </div>
            );
          case "approval_dec": {
            const ok = row.decision === "approved";
            const cls = ok
              ? "border-emerald-900/50 bg-emerald-950/30 text-emerald-300"
              : "border-red-900/50 bg-red-950/30 text-red-300";
            return (
              <div key={row.key} className={`rounded-xl border px-4 py-3 text-sm ${cls}`}>
                <span className="font-medium">
                  {row.decision === "expired"
                    ? "Approval expired"
                    : ok
                      ? "Approved"
                      : "Denied"}
                </span>
                {row.via ? (
                  <span className="text-zinc-500 text-xs"> · via {row.via}</span>
                ) : null}
              </div>
            );
          }
        }
      })}
    </div>
  );
}

function ToolBlock({ name, input }: { name: string; input: unknown }) {
  const [open, setOpen] = useState(false);
  return (
    <div className="rounded-xl border border-surface-border bg-black/20">
      <button
        type="button"
        onClick={() => setOpen((v) => !v)}
        className="flex w-full items-center justify-between gap-2 px-4 py-2.5 text-left text-sm"
      >
        <span className="font-mono text-accent-muted">
          tool · {name || "unknown"}
        </span>
        <span className="text-xs text-zinc-500">{open ? "Hide" : "Show"}</span>
      </button>
      {open && (
        <pre className="overflow-x-auto border-t border-surface-border p-3 text-xs font-mono text-zinc-300">
          {JSON.stringify(input, null, 2)}
        </pre>
      )}
    </div>
  );
}

function buildRows(events: TaskEvent[]): Row[] {
  const rows: Row[] = [];
  let streamBuf = "";
  let streamKey = "stream";

  const flushStream = () => {
    if (streamBuf) {
      rows.push({
        kind: "text",
        role: "assistant",
        text: streamBuf,
        partial: true,
        key: streamKey,
      });
      streamBuf = "";
    }
  };

  for (const ev of events) {
    const p = (ev.payload ?? {}) as Record<string, unknown>;
    switch (ev.type) {
      case "task_started":
        flushStream();
        rows.push({
          kind: "meta",
          label: `Session ${String(p.session_id ?? "—")}`,
          key: `m-${ev.seq}`,
        });
        break;
      case "message": {
        const partial = Boolean(p.partial);
        const role = String(p.role ?? "assistant");
        const text = extractText(p.content);
        if (partial) {
          streamBuf += text;
          streamKey = `s-${ev.seq}`;
        } else {
          flushStream();
          if (text || Array.isArray(p.content)) {
            rows.push({
              kind: "text",
              role,
              text: text || JSON.stringify(p.content),
              key: `t-${ev.seq}`,
            });
          }
        }
        break;
      }
      case "tool_use": {
        flushStream();
        // Claude: payload.content is the tool_use block; Codex: name + item.
        const content = p.content as Record<string, unknown> | undefined;
        const name = String(
          content?.name ?? p.name ?? (p.item as { type?: string } | undefined)?.type ?? "tool",
        );
        rows.push({
          kind: "tool",
          name,
          input: content?.input ?? content ?? p.item ?? p,
          key: `tool-${ev.seq}`,
        });
        break;
      }
      case "raw_output":
        flushStream();
        rows.push({
          kind: "raw",
          // Claude/codex stderr uses `line`; rawpty coalesced chunks use `chunk`.
          line: String(p.line ?? p.chunk ?? ""),
          key: `raw-${ev.seq}`,
        });
        break;
      case "error":
        flushStream();
        rows.push({
          kind: "error",
          message: String(p.message ?? "error"),
          key: `err-${ev.seq}`,
        });
        break;
      case "result":
        flushStream();
        rows.push({ kind: "result", payload: p, key: `res-${ev.seq}` });
        break;
      case "approval_requested": {
        flushStream();
        const payload = (p.payload ?? p) as Record<string, unknown>;
        const tool =
          String(
            (payload as { tool_name?: string }).tool_name ??
              (payload as { name?: string }).name ??
              "",
          ) || "tool";
        rows.push({
          kind: "approval_req",
          tool,
          approvalId: String(p.approval_id ?? ""),
          key: `ar-${ev.seq}`,
        });
        break;
      }
      case "approval_decided":
        flushStream();
        rows.push({
          kind: "approval_dec",
          decision: String(p.decision ?? ""),
          via: String(p.decided_via ?? ""),
          key: `ad-${ev.seq}`,
        });
        break;
      default:
        break;
    }
  }
  // Keep live partial buffer visible.
  if (streamBuf) {
    rows.push({
      kind: "text",
      role: "assistant",
      text: streamBuf,
      partial: true,
      key: streamKey,
    });
  }
  return rows;
}

function extractText(content: unknown): string {
  if (typeof content === "string") return content;
  if (!Array.isArray(content)) return "";
  return content
    .map((c) => {
      if (c && typeof c === "object" && "text" in c) {
        return String((c as { text: unknown }).text ?? "");
      }
      return "";
    })
    .join("");
}
