/**
 * One tool call: a status dot, the tool, what it was for, and — behind a tap —
 * the payload it was given and what came back.
 *
 * Extracted from `ChatStream` unchanged so the host's progress box and the
 * subagent panel draw a tool call the same way. The two are the same fact from
 * the same stream; a second face for it would be a second thing to keep honest.
 */
import { extractPrimaryToolPath } from "../../lib/changedFiles";
import { shortPath } from "../../lib/paths";
import { useT } from "../../i18n/react";
import { prettyToolName, type ToolStep } from "./transcriptProjection";

export default function ToolStepRow({
  tool,
  index,
  open,
  onToggle,
  onOpenPath,
}: {
  tool: ToolStep;
  index: number;
  open: boolean;
  onToggle: () => void;
  onOpenPath?: (path: string) => void;
}) {
  const tr = useT();
  const filePath = extractPrimaryToolPath(tool.name, tool.input);
  const hasDetail = (tool.output && tool.output.trim().length > 0) || tool.input != null;

  const statusDot =
    tool.status === "error"
      ? "bg-kin-red"
      : tool.status === "running"
        ? "bg-kin-blue animate-breathe"
        : "bg-kin-green";

  const statusText =
    tool.status === "error"
      ? tr("chat.progress.failed")
      : tool.status === "running"
        ? tr("chat.progress.running")
        : tr("chat.progress.done");

  return (
    <div className="text-body">
      <button
        type="button"
        onClick={() => hasDetail && onToggle()}
        className={[
          "w-full flex items-start gap-2 px-3 py-1.5 text-left",
          hasDetail ? "cursor-pointer  hover:bg-kin-fill" : "cursor-default",
        ].join(" ")}
        aria-expanded={open}
      >
        <span className="flex-none w-5 text-caption tabular-nums text-kin-muted pt-0.5">
          {index}
        </span>
        <span
          className={`mt-1.5 w-1.5 h-1.5 rounded-full flex-none ${statusDot}`}
          title={statusText}
        />
        <span className="font-mono text-caption text-kin-muted flex-none pt-px">
          {prettyToolName(tool.name)}
        </span>
        <span className="flex-1 min-w-0 break-words text-kin-secondary">{tool.summary}</span>
        {filePath && onOpenPath && (
          <button
            type="button"
            className="flex-none max-w-[40%] truncate font-mono text-caption text-kin-blue-ink hover:underline pt-0.5"
            title={filePath}
            onClick={(e) => {
              e.stopPropagation();
              onOpenPath(filePath);
            }}
          >
            {shortPath(filePath, 28)}
          </button>
        )}
        {hasDetail && (
          <span className="flex-none text-caption text-kin-muted pt-0.5">
            {open ? tr("chat.progress.hide") : tr("chat.progress.details")}
          </span>
        )}
      </button>
      {open && hasDetail && (
        <div className="px-3 pb-2 pl-10 space-y-1.5">
          {filePath && onOpenPath && (
            <button
              type="button"
              onClick={() => onOpenPath(filePath)}
              className="text-caption text-kin-blue-ink hover:underline font-mono"
              title={filePath}
            >
              {tr("workspace.openFile")} · {shortPath(filePath, 48)}
            </button>
          )}
          {tool.input != null && (
            <div>
              <div className="text-micro font-semibold uppercase tracking-label text-kin-muted mb-0.5">
                {tr("chat.progress.input")}
              </div>
              <pre className="overflow-x-auto max-h-28 text-caption font-mono text-kin-secondary whitespace-pre-wrap break-all rounded-md bg-[var(--kin-fill)] px-2 py-1.5">
                {formatToolJson(tool.input)}
              </pre>
            </div>
          )}
          {tool.output?.trim() && (
            <div>
              <div className="text-micro font-semibold uppercase tracking-label text-kin-muted mb-0.5">
                {tr("chat.progress.output")}
              </div>
              <pre className="overflow-x-auto max-h-36 text-caption font-mono text-kin-secondary whitespace-pre-wrap break-all rounded-md bg-[var(--kin-fill)] px-2 py-1.5">
                {tool.output}
              </pre>
            </div>
          )}
        </div>
      )}
    </div>
  );
}

function formatToolJson(input: unknown): string {
  if (typeof input === "string") return input;
  try {
    return JSON.stringify(input, null, 2);
  } catch {
    return String(input);
  }
}
