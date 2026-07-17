/**
 * Single-column chat transcript.
 * One user message → one agent reply column (single left avatar). Intermediate
 * multi-agent / tool steps collapse into a fixed-height progress box.
 */
import { useEffect, useMemo, useRef, useState, type ReactNode } from "react";
import type { TaskEvent } from "../../api/client";
import { extractPrimaryToolPath } from "../../lib/changedFiles";
import { shortPath } from "../../lib/paths";
import { t } from "../../i18n";
import { useLocale, useT } from "../../i18n/react";
import { agentAvatarMeta, agentDisplayName } from "../../lib/agentMention";
import Markdown from "../Markdown";

type Props = {
  events: TaskEvent[];
  /** Fallback first user bubble when create hasn't seeded events yet. */
  fallbackUserPrompt?: string;
  /** Approvals / cards rendered after messages. */
  trailing?: ReactNode;
  /**
   * Show a thinking/loading row while the task is live but nothing is
   * streaming yet (and no progress is mid-run).
   */
  loading?: boolean;
  /** Avatar speaker for the loading row (default: kin). */
  loadingSpeaker?: string;
  /**
   * The task's main/host agent (task.agent). Used as the progress-box host and
   * the fallback speaker so a non-Kin main agent (e.g. Claude Code) is attributed
   * to itself instead of Kin. Defaults to "kin".
   */
  hostSpeaker?: string;
  /** When true, show Retry / Fork on user messages (terminal tasks). */
  showMessageActions?: boolean;
  /** Busy flag while retry/fork request is in flight. */
  actionsBusy?: boolean;
  onRetry?: (fromSeq: number) => void;
  onFork?: (fromSeq: number) => void;
  /** Save assistant message body as an artifact. */
  onSaveArtifact?: (text: string) => void;
  /** Open a workspace path in the Files panel (from tool rows). */
  onOpenPath?: (path: string) => void;
};

type ToolStep = {
  kind: "tool";
  key: string;
  speaker: string;
  name: string;
  summary: string;
  status: "running" | "done" | "error";
  input?: unknown;
  output?: string;
};

type NoteStep = {
  kind: "note";
  key: string;
  speaker: string;
  text: string;
  status: "running" | "done" | "error";
};

type ProgressStep = ToolStep | NoteStep;

type ProgressItem = {
  kind: "progress";
  key: string;
  /** Host speaker for alignment (usually kin). */
  speaker: string;
  steps: ProgressStep[];
};

type ChatItem =
  | {
      kind: "message";
      key: string;
      speaker: string;
      text: string;
      partial?: boolean;
      /** Source event seq (for retry/fork). */
      seq?: number;
    }
  | ProgressItem
  | { kind: "error"; key: string; message: string }
  | { kind: "meta"; key: string; label: string };

/** Visual grouping: one user bubble, or one agent column (single avatar). */
type Turn =
  | { kind: "user"; item: Extract<ChatItem, { kind: "message" }> }
  | {
      kind: "agent";
      /** Host speaker for the shared left avatar. */
      speaker: string;
      items: ChatItem[];
    }
  | {
      kind: "standalone";
      item: Extract<ChatItem, { kind: "error" | "meta" }>;
    };

export default function ChatStream({
  events,
  fallbackUserPrompt,
  trailing,
  loading = false,
  loadingSpeaker = "kin",
  hostSpeaker = "kin",
  showMessageActions = false,
  actionsBusy = false,
  onRetry,
  onFork,
  onSaveArtifact,
  onOpenPath,
}: Props) {
  const { locale } = useLocale();
  // Rebuild when locale changes (tool summaries use t()).
  const items = useMemo(
    () => buildChatItems(events, hostSpeaker),
    [events, locale, hostSpeaker],
  );
  const turns = useMemo(
    () => groupIntoTurns(items, hostSpeaker),
    [items, hostSpeaker],
  );
  const hasUserMsg = items.some(
    (i) => i.kind === "message" && i.speaker === "user",
  );

  const hasPartial = items.some((i) => i.kind === "message" && i.partial);
  const lastIdx = items.length - 1;
  const hasRunningProgress = items.some((i, idx) => {
    if (i.kind !== "progress") return false;
    const stepRunning = i.steps.some((x) => x.status === "running");
    // Keep the latest progress "live" while the task is still running so the
    // box does not collapse between worker steps.
    const live = loading && idx === lastIdx;
    return stepRunning || live;
  });
  // Prefer streaming / progress chips over a generic loading row.
  const showLoading = loading && !hasPartial && !hasRunningProgress;

  // If the last turn is already an agent column, fold thinking into it so we
  // don't paint a second Kin avatar under the same user message.
  const lastTurn = turns[turns.length - 1];
  const loadingInsideAgent =
    showLoading && lastTurn?.kind === "agent";
  const loadingStandalone = showLoading && !loadingInsideAgent;

  return (
    <div className="max-w-[720px] mx-auto px-4 sm:px-7 flex flex-col gap-4">
      {!hasUserMsg && fallbackUserPrompt?.trim() && (
        <MessageRow
          speaker="user"
          text={fallbackUserPrompt}
          partial={false}
        />
      )}

      {turns.map((turn, turnIdx) => {
        switch (turn.kind) {
          case "user":
            return (
              <MessageRow
                key={turn.item.key}
                speaker={turn.item.speaker}
                text={turn.item.text}
                partial={turn.item.partial}
              />
            );
          case "standalone":
            return (
              <StandaloneRow key={turn.item.key} item={turn.item} />
            );
          case "agent": {
            const isLast = turnIdx === turns.length - 1;
            const withThinking = isLast && loadingInsideAgent;
            return (
              <AgentTurn
                key={`turn-${turn.items[0]?.key ?? turnIdx}`}
                speaker={turn.speaker}
                items={turn.items}
                loading={loading}
                lastItemIdx={lastIdx}
                allItems={items}
                showThinking={withThinking}
                showMessageActions={showMessageActions}
                actionsBusy={actionsBusy}
                onRetry={onRetry}
                onFork={onFork}
                onSaveArtifact={onSaveArtifact}
                onOpenPath={onOpenPath}
              />
            );
          }
        }
      })}

      {loadingStandalone && <ThinkingRow speaker={loadingSpeaker} />}

      {trailing}
    </div>
  );
}

/**
 * Group flat chat items into turns:
 * - each user message is its own turn
 * - consecutive agent content (messages + progress + errors/meta) after a
 *   user message share one left avatar column
 */
function groupIntoTurns(items: ChatItem[], hostSpeaker = "kin"): Turn[] {
  const turns: Turn[] = [];
  for (const item of items) {
    if (item.kind === "message" && item.speaker === "user") {
      turns.push({ kind: "user", item });
      continue;
    }
    if (item.kind === "error" || item.kind === "meta") {
      const last = turns[turns.length - 1];
      if (last?.kind === "agent") {
        last.items.push(item);
      } else {
        turns.push({ kind: "standalone", item });
      }
      continue;
    }
    // agent message or progress
    const last = turns[turns.length - 1];
    if (last?.kind === "agent") {
      last.items.push(item);
      continue;
    }
    const speaker =
      item.kind === "message"
        ? item.speaker
        : item.speaker || hostSpeaker;
    turns.push({ kind: "agent", speaker, items: [item] });
  }
  return turns;
}

/** One left avatar for the whole agent reply after a user message. */
function AgentTurn({
  speaker,
  items,
  loading,
  lastItemIdx,
  allItems,
  showThinking,
  showMessageActions = false,
  actionsBusy = false,
  onRetry,
  onFork,
  onSaveArtifact,
  onOpenPath,
}: {
  speaker: string;
  items: ChatItem[];
  loading: boolean;
  lastItemIdx: number;
  allItems: ChatItem[];
  showThinking: boolean;
  showMessageActions?: boolean;
  actionsBusy?: boolean;
  onRetry?: (fromSeq: number) => void;
  onFork?: (fromSeq: number) => void;
  onSaveArtifact?: (text: string) => void;
  onOpenPath?: (path: string) => void;
}) {
  const tr = useT();
  const meta = agentAvatarMeta(speaker);
  // Show the name once at the top of the column (not on every sub-block).
  const hasPartial = items.some((i) => i.kind === "message" && i.partial);

  return (
    <div className="flex gap-2.5 items-start">
      <div
        className={`w-[28px] h-[28px] flex-none rounded-[8px] flex items-center justify-center text-[11px] font-bold ${meta.className}`}
        title={meta.label}
      >
        {meta.initials}
      </div>
      <div className="flex-1 min-w-0 flex flex-col gap-2.5 pt-0.5">
        <div className="flex items-center gap-2">
          <span className="text-[12px] font-semibold text-kin-text">
            {meta.label}
          </span>
          {hasPartial && (
            <span className="inline-flex items-center gap-1.5 text-[11px] text-kin-muted">
              <span className="w-1.5 h-1.5 rounded-full bg-kin-blue animate-breathe" />
              {tr("chat.streaming")}
            </span>
          )}
          {showThinking && !hasPartial && (
            <span className="text-[11px] text-kin-muted">
              {tr("chat.thinking")}
            </span>
          )}
        </div>

        {items.map((item) => {
          switch (item.kind) {
            case "message": {
              const canSave =
                !!onSaveArtifact &&
                !item.partial &&
                item.text.trim().length > 0;
              const canRetryFork =
                showMessageActions &&
                !item.partial &&
                typeof item.seq === "number";
              return (
                <div key={item.key} className="group/msg space-y-1">
                  <MessageBody
                    text={item.text}
                    partial={item.partial}
                  />
                  {(canRetryFork || canSave) && (
                    <div
                      className="flex items-center gap-1 opacity-100 sm:opacity-0 sm:group-hover/msg:opacity-100 sm:focus-within:opacity-100 transition-opacity"
                      role="group"
                      aria-label={tr("task.actions")}
                    >
                      {canRetryFork && (
                        <>
                          <button
                            type="button"
                            disabled={actionsBusy}
                            title={tr("task.retryTitle")}
                            onClick={() => onRetry?.(item.seq!)}
                            className="px-2 py-0.5 rounded-md text-[11.5px] font-medium text-kin-muted hover:text-kin-text hover:bg-black/[.05] dark:hover:bg-white/[.06] disabled:opacity-40"
                          >
                            {tr("task.retry")}
                          </button>
                          <button
                            type="button"
                            disabled={actionsBusy}
                            title={tr("task.forkTitle")}
                            onClick={() => onFork?.(item.seq!)}
                            className="px-2 py-0.5 rounded-md text-[11.5px] font-medium text-kin-muted hover:text-kin-text hover:bg-black/[.05] dark:hover:bg-white/[.06] disabled:opacity-40"
                          >
                            {tr("task.fork")}
                          </button>
                        </>
                      )}
                      {canSave && (
                        <button
                          type="button"
                          disabled={actionsBusy}
                          title={tr("task.saveArtifactTitle")}
                          onClick={() => onSaveArtifact?.(item.text)}
                          className="px-2 py-0.5 rounded-md text-[11.5px] font-medium text-kin-muted hover:text-kin-text hover:bg-black/[.05] dark:hover:bg-white/[.06] disabled:opacity-40"
                        >
                          {tr("task.saveArtifact")}
                        </button>
                      )}
                    </div>
                  )}
                </div>
              );
            }
            case "progress": {
              const globalIdx = allItems.indexOf(item);
              const stepRunning = item.steps.some(
                (x) => x.status === "running",
              );
              const live = loading && globalIdx === lastItemIdx;
              return (
                <ProgressCard
                  key={item.key}
                  item={item}
                  running={stepRunning || live}
                  onOpenPath={onOpenPath}
                />
              );
            }
            case "error":
              return (
                <div
                  key={item.key}
                  className="rounded-xl border border-kin-red/30 bg-[rgba(255,69,58,.08)] px-3.5 py-2.5 text-[13.5px] text-kin-red"
                >
                  {item.message}
                </div>
              );
            case "meta":
              return (
                <p
                  key={item.key}
                  className="text-[11.5px] text-kin-muted"
                >
                  {item.label}
                </p>
              );
          }
        })}

        {showThinking && !hasPartial && <ThinkingDots />}
      </div>
    </div>
  );
}

function StandaloneRow({
  item,
}: {
  item: Extract<ChatItem, { kind: "error" | "meta" }>;
}) {
  if (item.kind === "error") {
    return (
      <div className="rounded-xl border border-kin-red/30 bg-[rgba(255,69,58,.08)] px-3.5 py-2.5 text-[13.5px] text-kin-red">
        {item.message}
      </div>
    );
  }
  return (
    <p className="text-center text-[11.5px] text-kin-muted">{item.label}</p>
  );
}

/** Animated “thinking” row while waiting for the first assistant token. */
function ThinkingRow({ speaker }: { speaker: string }) {
  const tr = useT();
  const meta = agentAvatarMeta(speaker);
  return (
    <div
      className="flex gap-2.5 items-start"
      role="status"
      aria-live="polite"
      aria-label={tr("chat.thinking")}
    >
      <div
        className={`w-[28px] h-[28px] flex-none rounded-[8px] flex items-center justify-center text-[11px] font-bold ${meta.className}`}
        title={meta.label}
      >
        {meta.initials}
      </div>
      <div className="flex-1 min-w-0 flex flex-col gap-1.5 pt-0.5">
        <div className="flex items-center gap-2">
          <span className="text-[12px] font-semibold text-kin-text">
            {meta.label}
          </span>
          <span className="text-[11px] text-kin-muted">{tr("chat.thinking")}</span>
        </div>
        <ThinkingDots />
      </div>
    </div>
  );
}

function ThinkingDots() {
  return (
    <div
      className="inline-flex items-center gap-1.5 h-7 px-3 rounded-2xl border border-[var(--kin-hairline)] bg-[var(--kin-fill)] w-fit"
      role="status"
      aria-live="polite"
    >
      <span className="kin-dot" style={{ animationDelay: "0ms" }} />
      <span className="kin-dot" style={{ animationDelay: "160ms" }} />
      <span className="kin-dot" style={{ animationDelay: "320ms" }} />
    </div>
  );
}

/**
 * Fixed-height scrolling progress box for tools + multi-agent step notes.
 * Expanded while live; collapses to a one-line summary when finished (expandable).
 * Avatar is owned by the parent AgentTurn — this card is content-only.
 */
function ProgressCard({
  item,
  running,
  onOpenPath,
}: {
  item: ProgressItem;
  running: boolean;
  onOpenPath?: (path: string) => void;
}) {
  const tr = useT();
  const steps = item.steps;
  const failed = steps.filter((x) => x.status === "error").length;
  const done = steps.filter((x) => x.status === "done").length;
  const count = steps.length;

  const [expanded, setExpanded] = useState(running);
  const [openStep, setOpenStep] = useState<string | null>(null);
  const scrollerRef = useRef<HTMLDivElement>(null);
  const wasRunning = useRef(running);

  useEffect(() => {
    if (running) {
      setExpanded(true);
      wasRunning.current = true;
    } else if (wasRunning.current) {
      // Just finished → auto-collapse to summary.
      setExpanded(false);
      wasRunning.current = false;
    }
  }, [running]);

  const stepsSig = steps
    .map((x) =>
      x.kind === "tool"
        ? `${x.key}:${x.status}:${x.summary}`
        : `${x.key}:${x.status}:${x.text.length}`,
    )
    .join("|");

  // Auto-scroll to latest step while running.
  useEffect(() => {
    if (!running || !expanded) return;
    const el = scrollerRef.current;
    if (!el) return;
    el.scrollTop = el.scrollHeight;
  }, [stepsSig, steps.length, running, expanded]);

  const summary = (() => {
    if (running) return tr("chat.progress.summaryRunning", { count });
    if (failed > 0 && done === 0)
      return tr("chat.progress.summaryFailed", { count });
    if (failed > 0)
      return tr("chat.progress.summaryMixed", { done, failed, count });
    return tr("chat.progress.summaryDone", { count });
  })();

  const statusTone = running
    ? "border-kin-blue/25 bg-kin-blue-soft/30"
    : failed > 0
      ? "border-kin-red/25 bg-[rgba(255,69,58,.05)]"
      : "border-[var(--kin-hairline)] bg-[var(--kin-fill)]";

  const badgeLabel = running
    ? tr("chat.progress.running")
    : failed > 0
      ? tr("chat.progress.failed")
      : tr("chat.progress.done");

  const badgeTone = running
    ? "bg-kin-blue/15 text-kin-blue"
    : failed > 0
      ? "bg-kin-red/15 text-kin-red"
      : "bg-[var(--kin-fill-strong)] text-kin-muted";

  // Latest step as a quick glance when collapsed.
  const latest = steps[steps.length - 1];
  const glance = latest
    ? latest.kind === "tool"
      ? `${prettyToolName(latest.name)}${latest.summary && latest.summary !== latest.name ? ` · ${shorten(latest.summary, 48)}` : ""}`
      : `${agentDisplayName(latest.speaker)} · ${shorten(latest.text, 48)}`
    : "";

  return (
    <div
      className={`rounded-xl border ${statusTone} overflow-hidden`}
    >
      <button
        type="button"
        onClick={() => setExpanded((v) => !v)}
        className="w-full flex items-center gap-2 px-3 py-2 text-left text-[12.5px] cursor-pointer hover:bg-black/[.03] dark:hover:bg-white/[.03]"
        aria-expanded={expanded}
      >
        <span
          className={[
            "flex-none text-[10px] font-semibold uppercase tracking-wide px-1.5 py-0.5 rounded",
            badgeTone,
          ].join(" ")}
        >
          {running ? (
            <span className="inline-flex items-center gap-1">
              <span className="w-1.5 h-1.5 rounded-full bg-kin-blue animate-breathe" />
              {badgeLabel}
            </span>
          ) : (
            badgeLabel
          )}
        </span>
        <span className="truncate text-kin-text flex-1 min-w-0 font-medium">
          {summary}
        </span>
        {!expanded && glance && (
          <span className="hidden sm:inline truncate max-w-[40%] text-[11.5px] text-kin-muted font-mono">
            {glance}
          </span>
        )}
        <span className="flex-none text-[11px] text-kin-muted tabular-nums">
          {expanded ? tr("chat.progress.collapse") : tr("chat.progress.expand")}
        </span>
      </button>

      {expanded && (
        <div className="border-t border-[var(--kin-hairline)] bg-[var(--kin-elevated)]/30">
          <div
            ref={scrollerRef}
            className="max-h-[160px] overflow-y-auto kin-scroll divide-y divide-[var(--kin-hairline)]"
          >
            {steps.map((step, idx) =>
              step.kind === "tool" ? (
                <ToolStepRow
                  key={step.key}
                  tool={step}
                  index={idx + 1}
                  open={openStep === step.key}
                  onOpenPath={onOpenPath}
                  onToggle={() =>
                    setOpenStep((cur) =>
                      cur === step.key ? null : step.key,
                    )
                  }
                />
              ) : (
                <NoteStepRow
                  key={step.key}
                  note={step}
                  index={idx + 1}
                  open={openStep === step.key}
                  onToggle={() =>
                    setOpenStep((cur) =>
                      cur === step.key ? null : step.key,
                    )
                  }
                />
              ),
            )}
          </div>
        </div>
      )}
    </div>
  );
}

function NoteStepRow({
  note,
  index,
  open,
  onToggle,
}: {
  note: NoteStep;
  index: number;
  open: boolean;
  onToggle: () => void;
}) {
  const tr = useT();
  const meta = agentAvatarMeta(note.speaker);
  const long = note.text.trim().length > 120 || note.text.includes("\n");
  const hasDetail = long || note.text.trim().length > 0;

  const statusDot =
    note.status === "error"
      ? "bg-kin-red"
      : note.status === "running"
        ? "bg-kin-blue animate-breathe"
        : "bg-kin-green";

  const statusText =
    note.status === "error"
      ? tr("chat.progress.failed")
      : note.status === "running"
        ? tr("chat.progress.running")
        : tr("chat.progress.done");

  return (
    <div className="text-[12px]">
      <button
        type="button"
        onClick={() => hasDetail && onToggle()}
        className={[
          "w-full flex items-start gap-2 px-3 py-1.5 text-left",
          hasDetail
            ? "cursor-pointer hover:bg-black/[.03] dark:hover:bg-white/[.03]"
            : "cursor-default",
        ].join(" ")}
        aria-expanded={open}
      >
        <span className="flex-none w-5 text-[10.5px] tabular-nums text-kin-muted pt-0.5">
          {index}
        </span>
        <span
          className={`mt-1.5 w-1.5 h-1.5 rounded-full flex-none ${statusDot}`}
          title={statusText}
        />
        <span
          className={`flex-none mt-0.5 w-4 h-4 rounded-[4px] flex items-center justify-center text-[8px] font-bold ${meta.className}`}
          title={meta.label}
        >
          {meta.initials}
        </span>
        <span className="font-medium text-[11.5px] text-kin-muted flex-none pt-px">
          {meta.label}
        </span>
        <span className="flex-1 min-w-0 truncate text-kin-secondary">
          {shorten(note.text, 80)}
        </span>
        {hasDetail && (
          <span className="flex-none text-[10.5px] text-kin-muted pt-0.5">
            {open ? tr("chat.progress.hide") : tr("chat.progress.details")}
          </span>
        )}
      </button>
      {open && (
        <div className="px-3 pb-2 pl-10">
          <div className="text-[12.5px] leading-relaxed text-kin-secondary rounded-md bg-[var(--kin-fill)] px-2.5 py-2 max-h-40 overflow-y-auto kin-scroll">
            <Markdown text={note.text} />
          </div>
        </div>
      )}
    </div>
  );
}

function ToolStepRow({
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
  const hasDetail =
    (tool.output && tool.output.trim().length > 0) || tool.input != null;

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
    <div className="text-[12px]">
      <button
        type="button"
        onClick={() => hasDetail && onToggle()}
        className={[
          "w-full flex items-start gap-2 px-3 py-1.5 text-left",
          hasDetail
            ? "cursor-pointer hover:bg-black/[.03] dark:hover:bg-white/[.03]"
            : "cursor-default",
        ].join(" ")}
        aria-expanded={open}
      >
        <span className="flex-none w-5 text-[10.5px] tabular-nums text-kin-muted pt-0.5">
          {index}
        </span>
        <span
          className={`mt-1.5 w-1.5 h-1.5 rounded-full flex-none ${statusDot}`}
          title={statusText}
        />
        <span className="font-mono text-[11px] text-kin-muted flex-none pt-px">
          {prettyToolName(tool.name)}
        </span>
        <span className="flex-1 min-w-0 truncate text-kin-secondary">
          {tool.summary}
        </span>
        {filePath && onOpenPath && (
          <button
            type="button"
            className="flex-none max-w-[40%] truncate font-mono text-[10.5px] text-kin-blue hover:underline pt-0.5"
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
          <span className="flex-none text-[10.5px] text-kin-muted pt-0.5">
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
              className="text-[11.5px] text-kin-blue hover:underline font-mono"
              title={filePath}
            >
              {tr("workspace.openFile")} · {shortPath(filePath, 48)}
            </button>
          )}
          {tool.input != null && (
            <div>
              <div className="text-[10px] font-semibold uppercase tracking-wide text-kin-muted mb-0.5">
                {tr("chat.progress.input")}
              </div>
              <pre className="overflow-x-auto max-h-28 text-[11px] font-mono text-kin-secondary whitespace-pre-wrap break-all rounded-md bg-[var(--kin-fill)] px-2 py-1.5">
                {formatToolJson(tool.input)}
              </pre>
            </div>
          )}
          {tool.output?.trim() && (
            <div>
              <div className="text-[10px] font-semibold uppercase tracking-wide text-kin-muted mb-0.5">
                {tr("chat.progress.output")}
              </div>
              <pre className="overflow-x-auto max-h-36 text-[11px] font-mono text-kin-secondary whitespace-pre-wrap break-all rounded-md bg-[var(--kin-fill)] px-2 py-1.5">
                {tool.output}
              </pre>
            </div>
          )}
        </div>
      )}
    </div>
  );
}

function prettyToolName(name: string): string {
  switch (name) {
    case "bash":
      return "shell";
    case "read_file":
      return "read";
    case "write_file":
      return "write";
    case "list_dir":
      return "list";
    case "glob":
      return "glob";
    default:
      return name || "tool";
  }
}

function formatToolJson(input: unknown): string {
  if (typeof input === "string") return input;
  try {
    return JSON.stringify(input, null, 2);
  } catch {
    return String(input);
  }
}

function shorten(s: string, max: number): string {
  const t = s.replace(/\s+/g, " ").trim();
  if (t.length <= max) return t;
  return t.slice(0, max - 1) + "…";
}

/** Message body only (avatar / name owned by AgentTurn for assistants). */
function MessageBody({
  text,
  partial,
}: {
  text: string;
  partial?: boolean;
}) {
  return (
    <div className="text-[14px] sm:text-[15px] leading-relaxed text-kin-text">
      <Markdown text={text} />
      {partial && !text.trim() && <ThinkingDots />}
      {partial && text.trim() && (
        <span
          className="inline-block w-[2px] h-[1em] ml-0.5 align-[-2px] bg-kin-blue animate-pulse"
          aria-hidden
        />
      )}
    </div>
  );
}

function MessageRow({
  speaker,
  text,
  partial,
}: {
  speaker: string;
  text: string;
  partial?: boolean;
}) {
  const tr = useT();
  const isUser = speaker === "user";
  const meta = agentAvatarMeta(speaker);

  if (isUser) {
    return (
      <div className="flex justify-end gap-2.5 items-start">
        <div className="max-w-[85%] sm:max-w-[78%] flex flex-col items-end gap-1">
          <div className="text-[11.5px] font-medium text-kin-muted px-1">
            {meta.label}
          </div>
          <div
            className="px-3.5 py-2.5 rounded-[18px] rounded-br-[5px] text-[14px] sm:text-[15px] leading-relaxed whitespace-pre-wrap"
            style={{
              background: "var(--kin-bubble-user)",
              color: "var(--kin-bubble-user-fg)",
            }}
          >
            {text}
          </div>
        </div>
        <div
          className={`w-[28px] h-[28px] flex-none rounded-full flex items-center justify-center text-[11px] font-bold ${meta.className}`}
          title={meta.label}
        >
          {meta.initials}
        </div>
      </div>
    );
  }

  // Fallback single-row assistant render (not used via AgentTurn path).
  return (
    <div className="flex gap-2.5 items-start">
      <div
        className={`w-[28px] h-[28px] flex-none rounded-[8px] flex items-center justify-center text-[11px] font-bold ${meta.className}`}
        title={meta.label}
      >
        {meta.initials}
      </div>
      <div className="flex-1 min-w-0 flex flex-col gap-1 pt-0.5">
        <div className="flex items-center gap-2">
          <span className="text-[12px] font-semibold text-kin-text">
            {meta.label}
          </span>
          {partial && (
            <span className="inline-flex items-center gap-1.5 text-[11px] text-kin-muted">
              <span className="w-1.5 h-1.5 rounded-full bg-kin-blue animate-breathe" />
              {tr("chat.streaming")}
            </span>
          )}
        </div>
        <MessageBody text={text} partial={partial} />
      </div>
    </div>
  );
}

function buildChatItems(
  events: TaskEvent[],
  hostSpeaker = "kin",
): ChatItem[] {
  const items: ChatItem[] = [];
  let streamBuf = "";
  let streamSpeaker = hostSpeaker;
  let streamKey = "stream";
  let streamProgress = false;

  // Merge tool_use → tool_result by tool_use_id so UI shows one step.
  const toolById = new Map<string, ToolStep>();
  // Active open progress group (tools + intermediate notes between user-facing msgs).
  // Box avoids TS CFA treating nested-function writes as unreachable.
  const progressRef: { current: ProgressItem | null } = { current: null };
  // Streaming note step key inside the progress box.
  let streamNoteKey: string | null = null;

  const flushStream = () => {
    if (!streamBuf) return;
    if (streamProgress) {
      // Finalize streaming note inside progress.
      const active = progressRef.current;
      if (streamNoteKey && active) {
        const note = active.steps.find(
          (s): s is NoteStep => s.kind === "note" && s.key === streamNoteKey,
        );
        if (note) {
          note.text = streamBuf;
          note.status = "done";
        } else {
          pushNote(streamSpeaker, streamBuf, streamKey, "done");
        }
      } else {
        pushNote(streamSpeaker, streamBuf, streamKey, "done");
      }
    } else {
      progressRef.current = null;
      streamNoteKey = null;
      items.push({
        kind: "message",
        key: streamKey,
        speaker: streamSpeaker,
        text: streamBuf,
        partial: true,
        // streamKey is `s-${ev.seq}` — not stable for actions; omit seq while partial.
      });
    }
    streamBuf = "";
    streamNoteKey = null;
  };

  const ensureProgress = (hostSpeaker: string): ProgressItem => {
    if (progressRef.current) return progressRef.current;
    const prog: ProgressItem = {
      kind: "progress",
      key: `prog-${items.length}`,
      speaker: hostSpeaker || "kin",
      steps: [],
    };
    items.push(prog);
    progressRef.current = prog;
    return prog;
  };

  const pushNote = (
    speaker: string,
    text: string,
    key: string,
    status: NoteStep["status"],
  ) => {
    const prog = ensureProgress(hostSpeaker);
    // Coalesce consecutive partial updates onto the same note.
    const last = prog.steps[prog.steps.length - 1];
    if (
      last &&
      last.kind === "note" &&
      last.key === key &&
      last.speaker === speaker
    ) {
      last.text = text;
      last.status = status;
      return;
    }
    if (
      last &&
      last.kind === "note" &&
      last.speaker === speaker &&
      last.status === "running" &&
      status === "running"
    ) {
      last.text = text;
      last.key = key;
      return;
    }
    prog.steps.push({
      kind: "note",
      key,
      speaker,
      text,
      status,
    });
  };

  const upsertTool = (
    id: string,
    patch: Partial<ToolStep> & { name: string; speaker: string },
  ) => {
    const existing = toolById.get(id);
    if (existing) {
      Object.assign(existing, patch);
      return;
    }
    const item: ToolStep = {
      kind: "tool",
      key: `tool-${id}`,
      speaker: patch.speaker,
      name: patch.name,
      summary: patch.summary ?? patch.name,
      status: patch.status ?? "running",
      input: patch.input,
      output: patch.output,
    };
    toolById.set(id, item);
    ensureProgress(hostSpeaker).steps.push(item);
  };

  for (const ev of events) {
    const p = (ev.payload ?? {}) as Record<string, unknown>;
    const speaker = resolveSpeaker(p, hostSpeaker);

    switch (ev.type) {
      case "message": {
        const partial = Boolean(p.partial);
        const role = String(p.role ?? "assistant");
        const sp = role === "user" ? "user" : speaker;
        const text =
          extractText(p.content) ||
          (typeof p.text === "string" ? p.text : "");
        // Skip legacy expanded tool dumps from older kinagent builds.
        if (isLegacyToolDumpMessage(text)) {
          flushStream();
          streamNoteKey = null;
          const legacy = parseLegacyToolDump(text, sp, `legacy-${ev.seq}`);
          if (legacy) {
            ensureProgress(hostSpeaker).steps.push(legacy);
            toolById.set(legacy.key, legacy);
          }
          break;
        }

        const asProgress = sp !== "user" && isProgressMessage(p, sp, text);

        if (partial) {
          // Switching between speakers / progress vs final message flushes.
          if (
            streamBuf &&
            (streamSpeaker !== sp || streamProgress !== asProgress)
          ) {
            flushStream();
          }
          if (asProgress) {
            if (!streamBuf) {
              // Opening a progress stream closes nothing else; stays in box.
              streamNoteKey = `note-s-${ev.seq}`;
            }
            streamBuf += text;
            streamSpeaker = sp;
            streamKey = `s-${ev.seq}`;
            streamProgress = true;
            pushNote(
              sp,
              streamBuf,
              streamNoteKey ?? streamKey,
              "running",
            );
          } else {
            // User-facing stream closes the progress group.
            if (!streamBuf) {
              progressRef.current = null;
              streamNoteKey = null;
            }
            streamBuf += text;
            streamSpeaker = sp;
            streamKey = `s-${ev.seq}`;
            streamProgress = false;
          }
        } else {
          flushStream();
          streamNoteKey = null;
          if (!text.trim()) break;
          if (asProgress) {
            pushNote(sp, text, `note-${ev.seq}`, "done");
          } else {
            progressRef.current = null;
            items.push({
              kind: "message",
              key: `t-${ev.seq}`,
              speaker: sp,
              text,
              seq: ev.seq,
            });
          }
        }
        break;
      }
      case "tool_use": {
        // Worker tools are task-only; the host agent's own tools show in chat.
        if (!isUserFacingEvent(p, speaker)) {
          break;
        }
        flushStream();
        streamNoteKey = null;
        const content = p.content as Record<string, unknown> | undefined;
        const name = String(
          content?.name ??
            p.name ??
            p.tool_name ??
            (p.item as { type?: string } | undefined)?.type ??
            "tool",
        );
        const id = String(p.tool_use_id ?? p.id ?? `seq-${ev.seq}`);
        const summary =
          typeof p.summary === "string" && p.summary
            ? p.summary
            : `${t("chat.progress.running")} · ${prettyToolName(name)}`;
        upsertTool(id, {
          name,
          speaker,
          summary,
          status: "running",
          input: p.input ?? content?.input ?? content,
        });
        break;
      }
      case "tool_result": {
        if (!isUserFacingEvent(p, speaker)) {
          break;
        }
        flushStream();
        streamNoteKey = null;
        const name = String(p.name ?? p.tool_name ?? "tool");
        const id = String(p.tool_use_id ?? p.id ?? `seq-${ev.seq}`);
        const ok = p.ok !== false && p.status !== "error";
        const summary =
          typeof p.summary === "string" && p.summary
            ? p.summary
            : `${ok ? t("chat.progress.done") : t("chat.progress.failed")} · ${prettyToolName(name)}`;
        upsertTool(id, {
          name,
          speaker,
          summary,
          status: ok ? "done" : "error",
          input: p.input,
          output: typeof p.output === "string" ? p.output : undefined,
        });
        break;
      }
      case "error":
        flushStream();
        streamNoteKey = null;
        progressRef.current = null;
        items.push({
          kind: "error",
          key: `err-${ev.seq}`,
          message: String(p.message ?? "error"),
        });
        break;
      case "task_started":
        break;
      case "result": {
        // Orchestrator / adapter result closes the open progress group.
        flushStream();
        streamNoteKey = null;
        // Mark any still-running steps as done so the card can collapse.
        const open = progressRef.current;
        if (open) {
          for (const s of open.steps) {
            if (s.status === "running") s.status = "done";
          }
        }
        progressRef.current = null;
        break;
      }
      case "approval_requested":
        flushStream();
        streamNoteKey = null;
        progressRef.current = null;
        items.push({
          kind: "meta",
          key: `ar-${ev.seq}`,
          label: t("chat.needsApproval"),
        });
        break;
      default:
        break;
    }
  }
  flushStream();
  return items;
}

/** Old kinagent dumped tools as markdown messages: **bash**\n```...``` */
function isLegacyToolDumpMessage(text: string): boolean {
  return /^\*\*(bash|read_file|write_file|list_dir|glob)\*\*\s*\n```/m.test(
    text.trim(),
  );
}

function parseLegacyToolDump(
  text: string,
  speaker: string,
  key: string,
): ToolStep | null {
  const m = text
    .trim()
    .match(/^\*\*([a-z_]+)\*\*\s*\n```(?:\w*)\n?([\s\S]*?)```\s*$/i);
  if (!m) return null;
  const name = m[1];
  const output = m[2].trim();
  const failed = /^ERROR:/m.test(output) || output.includes("ERROR: ");
  const lines = countLines(output);
  return {
    kind: "tool",
    key,
    speaker,
    name,
    summary: `${failed ? t("chat.progress.failed") : t("chat.progress.done")} · ${prettyToolName(name)} · ${t("chat.progress.lines", { n: lines })}`,
    status: failed ? "error" : "done",
    output,
  };
}

function countLines(s: string): number {
  const t = s.replace(/\n+$/, "");
  if (!t) return 0;
  return t.split("\n").length;
}

function resolveSpeaker(
  p: Record<string, unknown>,
  hostSpeaker = "kin",
): string {
  const s = p.speaker ?? p.agent ?? p.source;
  if (
    typeof s === "string" &&
    s &&
    s !== "follow_up" &&
    s !== "handoff" &&
    s !== "create" &&
    s !== "orchestrate" &&
    s !== "orchestrator" &&
    s !== "delegate"
  ) {
    if (
      s === "kin" ||
      s === "claude-code" ||
      s === "codex" ||
      s === "grok" ||
      s === "user"
    ) {
      return s;
    }
    if (["claude-code", "codex", "grok", "kin"].includes(s)) return s;
  }
  if (p.role === "user") return "user";
  if (p.source === "orchestrator" || p.source === "delegate") return "kin";
  return hostSpeaker;
}

/**
 * Whether an event is user-facing (shown in the main chat column) vs a
 * task-only worker step. Prefers the backend's explicit visibility flag; falls
 * back to the Kin-only assumption for legacy events without visibility.
 */
function isUserFacingEvent(
  p: Record<string, unknown>,
  speaker: string,
): boolean {
  const source = String(p.source ?? "");
  if (source === "orchestrator" || source === "delegate") return true;
  const v = p.visibility as { task?: boolean; user?: boolean } | undefined;
  if (v && typeof v.user === "boolean") return v.user;
  return speaker === "kin" || speaker === "user";
}

/**
 * Intermediate multi-agent / worker chatter goes into the progress box.
 * Final orchestrator summaries and normal Kin replies stay as chat bubbles.
 */
function isProgressMessage(
  p: Record<string, unknown>,
  speaker: string,
  text: string,
): boolean {
  if (speaker === "user") return false;
  const source = String(p.source ?? "");
  if (source === "delegate") return true;
  if (source === "orchestrator") {
    // Final summary from buildMainSummary: "完成：" / "完成（有失败）："
    if (isOrchestratorSummary(text)) return false;
    return true;
  }
  if (isTaskOnly(p, speaker)) return true;
  return false;
}

function isOrchestratorSummary(text: string): boolean {
  const t = text.trim();
  // zh from buildMainSummary; en-friendly fallbacks if copy changes later.
  return (
    /^完成(（有失败）)?[：:]/u.test(t) ||
    /^(done|completed)([:：]|\s*\()/i.test(t)
  );
}

function isTaskOnly(p: Record<string, unknown>, speaker: string): boolean {
  if (speaker === "user") return false;
  const source = String(p.source ?? "");
  if (source === "orchestrator" || source === "delegate") return false;
  const v = p.visibility as { task?: boolean; user?: boolean } | undefined;
  if (v && (typeof v.user === "boolean" || typeof v.task === "boolean")) {
    // A user-facing event (main/single host agent) is never task-only, even
    // when it is also task-visible. Only user:false steps are worker chatter.
    if (v.user) return false;
    if (v.task) return true;
  }
  return speaker !== "kin" && speaker !== "user";
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
