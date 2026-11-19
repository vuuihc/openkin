/**
 * One tool call: a status dot, the tool, what it was for, and — behind a tap —
 * the payload it was given and what came back.
 *
 * Extracted from `ChatStream` unchanged so the host's progress box and the
 * subagent panel draw a tool call the same way. The two are the same fact from
 * the same stream; a second face for it would be a second thing to keep honest.
 */
import { extractPrimaryToolPath } from "../../lib/changedFiles";
import { formatDuration } from "../../lib/duration";
import { shortPath } from "../../lib/paths";
import { useT } from "../../i18n/react";
import Button from "../ui/Button";
import { prettyToolName, type ToolStep } from "./transcriptProjection";

export default function ToolStepRow({
  tool,
  index,
  depth = 0,
  open,
  onToggle,
  onOpenPath,
  canOpenPath,
}: {
  tool: ToolStep;
  /** The step's number in the box; 0 for a nested row, which shows a tick instead. */
  index: number;
  /** Nesting under the call that spawned it; 0 is the main thread. */
  depth?: number;
  open: boolean;
  onToggle: () => void;
  onOpenPath?: (path: string) => void;
  /** Whether the checkout can open this path; absent means today's answer. */
  canOpenPath?: (path: string) => boolean;
}) {
  const tr = useT();
  const filePath = extractPrimaryToolPath(tool.name, tool.input);
  const hasDetail = (tool.output && tool.output.trim().length > 0) || tool.input != null;
  // A nested row is indented under its parent, and its payload follows it in.
  const indent = depth > 0 ? { paddingLeft: 12 + depth * 16 } : undefined;
  const detailIndent = depth > 0 ? { paddingLeft: 40 + depth * 16 } : undefined;

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
      {/* A full-width disclosure row on the console's facade: the button is the
          hit area the facade draws its focus ring and phone floor around, and
          the row's own geometry (padding, gap, alignment) sits on the content
          span inside it, which is where Astryx puts a button's children. */}
      <Button
        variant="quiet"
        onClick={() => hasDetail && onToggle()}
        className={[
          // `hover:bg-transparent` keeps the quiet variant from filling the
          // whole button: the row's own fill belongs to the content span below,
          // where the old button painted it, and a row with nothing behind it is
          // not a control and gets none.
          "flex w-full justify-start rounded-sm p-0 text-left font-normal hover:bg-transparent",
          hasDetail ? "cursor-pointer" : "cursor-default",
        ].join(" ")}
        style={indent}
        aria-expanded={open}
      >
        <span
          className={[
            "flex w-full items-start gap-2 px-3 py-1.5",
            hasDetail ? "hover:bg-kin-fill" : "",
          ].join(" ")}
        >
          <span
            className="flex-none w-5 text-caption tabular-nums text-kin-muted pt-0.5"
            aria-hidden={depth > 0 ? true : undefined}
          >
            {depth > 0 ? "↳" : index}
          </span>
          <span
            className={`mt-1.5 w-1.5 h-1.5 rounded-full flex-none ${statusDot}`}
            title={statusText}
          />
          <span className="font-mono text-caption text-kin-muted flex-none pt-px">
            {prettyToolName(tool.name)}
          </span>
          {tool.sidechain && (
            // Whose call it was, said once per row: a subagent's work is the same
            // shape of row, and without the mark it would read as the main
            // agent's own.
            <span className="flex-none rounded bg-[var(--kin-fill-strong)] px-1 text-micro text-kin-muted">
              {tr("chat.progress.subagent")}
            </span>
          )}
          <span className="flex-1 min-w-0 break-words text-kin-secondary">{tool.summary}</span>
          {tool.status !== "running" && tool.durationMs != null && (
            // How long this one call took. A running call has no duration yet,
            // and a number that does not tick would be a lie.
            <span
              className="flex-none text-caption tabular-nums text-kin-muted pt-0.5"
              data-tool-duration={tool.durationMs}
            >
              {formatDuration(tool.durationMs)}
            </span>
          )}
          {filePath &&
            onOpenPath &&
            ((canOpenPath?.(filePath) ?? true) ? (
              // The chip shares the facade's focus ring and press treatment, but
              // stays a link: no fill on hover, and the ink is the link blue rather
              // than the quiet variant's text colour, so it sits on the content.
              <Button
                variant="quiet"
                className="flex-none max-w-[40%] justify-start rounded-md p-0 pt-0.5 text-left font-mono text-caption font-normal hover:bg-transparent hover:underline"
                title={filePath}
                onClick={(e) => {
                  e.stopPropagation();
                  onOpenPath(filePath);
                }}
              >
                <span className="block truncate text-kin-blue-ink">{shortPath(filePath, 28)}</span>
              </Button>
            ) : (
              // Outside the checkout there is nothing to open, so the chip
              // becomes a fact: the path, muted, with no press or focus.
              <span
                className="flex-none max-w-[40%] truncate pt-0.5 font-mono text-caption text-kin-muted"
                title={filePath}
              >
                {tr("workspace.outsideWorkspace")}
              </span>
            ))}
          {hasDetail && (
            <span className="flex-none text-caption text-kin-muted pt-0.5">
              {open ? tr("chat.progress.hide") : tr("chat.progress.details")}
            </span>
          )}
        </span>
      </Button>
      {open && hasDetail && (
        <div className="px-3 pb-2 pl-10 space-y-1.5" style={detailIndent}>
          {filePath &&
            onOpenPath &&
            ((canOpenPath?.(filePath) ?? true) ? (
              <Button
                variant="quiet"
                onClick={() => onOpenPath(filePath)}
                className="justify-start rounded-md p-0 text-left font-mono text-caption font-normal hover:bg-transparent hover:underline"
                title={filePath}
              >
                <span className="text-kin-blue-ink">
                  {tr("workspace.openFile")} · {shortPath(filePath, 48)}
                </span>
              </Button>
            ) : (
              <span className="block font-mono text-caption text-kin-muted" title={filePath}>
                {tr("workspace.outsideWorkspace")}
              </span>
            ))}
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
