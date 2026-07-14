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
  | { kind: "meta"; label: string; key: string };

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
                    ? "border-surface-border bg-surface/60"
                    : "border-surface-border bg-surface-raised"
                }`}
              >
                <div className="mb-1 text-[10px] uppercase tracking-wide text-zinc-500">
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
                className="overflow-x-auto rounded-lg bg-black/30 border border-surface-border p-2 text-[11px] font-mono text-zinc-500"
              >
                {row.line}
              </pre>
            );
          case "error":
            return (
              <div
                key={row.key}
                className="rounded-xl border border-red-900/60 bg-red-950/40 px-4 py-3 text-sm text-red-200"
              >
                {row.message}
              </div>
            );
          case "result":
            return (
              <div
                key={row.key}
                className="rounded-xl border border-emerald-900/40 bg-emerald-950/20 px-4 py-3 text-xs text-zinc-400"
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
        const content = p.content as Record<string, unknown> | undefined;
        rows.push({
          kind: "tool",
          name: String(content?.name ?? "tool"),
          input: content?.input ?? content,
          key: `tool-${ev.seq}`,
        });
        break;
      }
      case "raw_output":
        flushStream();
        rows.push({
          kind: "raw",
          line: String(p.line ?? ""),
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
