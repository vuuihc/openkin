/**
 * Single-column chat transcript.
 * One user message → one agent reply column (single left avatar). Intermediate
 * multi-agent / tool steps collapse into a fixed-height progress box.
 */
import { useEffect, useMemo, useRef, useState, type ReactNode } from "react";
import type { TaskEvent } from "../../api/client";
import { extractPrimaryToolPath } from "../../lib/changedFiles";
import { shortPath } from "../../lib/paths";
import { friendlyErrorLabel } from "../../lib/friendlyError";
import { useLocale, useT } from "../../i18n/react";
import { agentAvatarMeta, agentDisplayName } from "../../lib/agentMention";
import { useAppStore } from "../../store/appStore";
import { IconCopy, IconDownload, IconShare } from "../icons";
import Markdown from "../Markdown";
import {
  formatSharedHTML,
  formatSharedText,
  type SharedMessage,
} from "./shareExport";
import {
  buildChatItems,
  findSpeakerModel,
  groupIntoTurns,
  normalizeModel,
  prettyToolName,
  type ChatItem,
  type NoteStep,
  type ProgressItem,
  type ToolStep,
} from "./transcriptProjection";

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
  /** Avatar speaker for the loading row (pass the session host). */
  loadingSpeaker?: string;
  /**
   * The task's main/host agent (task.agent). Used as the progress-box host and
   * the fallback speaker so a non-Kin main agent (e.g. Claude Code) is attributed
   * to itself instead of Kin. Defaults to empty; pass the session host.
   */
  hostSpeaker?: string;
  /** Selected main-agent model; adapter events may replace it with the reported model. */
  hostModel?: string | null;
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

export default function ChatStream({
  events,
  fallbackUserPrompt,
  trailing,
  loading = false,
  loadingSpeaker = "",
  hostSpeaker = "",
  hostModel,
  showMessageActions = false,
  actionsBusy = false,
  onRetry,
  onFork,
  onSaveArtifact,
  onOpenPath,
}: Props) {
  const { locale } = useLocale();
  const tr = useT();
  const pushToast = useAppStore((s) => s.pushToast);
  const [sharing, setSharing] = useState(false);
  const [selectedKeys, setSelectedKeys] = useState<Set<string>>(
    () => new Set(),
  );
  // Rebuild when locale changes (tool summaries use t()).
  const items = useMemo(
    () => buildChatItems(events, hostSpeaker, hostModel, !loading),
    [events, locale, hostSpeaker, hostModel, loading],
  );
  const turns = useMemo(
    () => groupIntoTurns(items, hostSpeaker, normalizeModel(hostModel)),
    [items, hostSpeaker, hostModel],
  );
  const resolvedHostModel = useMemo(
    () => findSpeakerModel(events, hostSpeaker) ?? normalizeModel(hostModel),
    [events, hostSpeaker, hostModel],
  );
  const hasUserMsg = items.some(
    (i) => i.kind === "message" && i.speaker === "user",
  );
  const selectableMessages = useMemo(
    () =>
      items.filter(
        (item): item is Extract<ChatItem, { kind: "message" }> =>
          item.kind === "message" &&
          !item.partial &&
          item.text.trim().length > 0,
      ),
    [items],
  );
  const selectableKeys = useMemo(
    () => new Set(selectableMessages.map((item) => item.key)),
    [selectableMessages],
  );
  const selectedMessages = useMemo<SharedMessage[]>(
    () =>
      selectableMessages
        .filter((item) => selectedKeys.has(item.key))
        .map((item) => ({
          role: item.speaker === "user" ? "user" : "assistant",
          text: item.text,
        })),
    [selectableMessages, selectedKeys],
  );

  useEffect(() => {
    setSelectedKeys((previous) => {
      const next = new Set(
        [...previous].filter((key) => selectableKeys.has(key)),
      );
      return next.size === previous.size ? previous : next;
    });
  }, [selectableKeys]);

  const copyMessage = async (text: string) => {
    try {
      await copyToClipboard(text);
      pushToast(tr("chat.message.copied"), "info");
    } catch {
      pushToast(tr("chat.message.copyFailed"), "error");
    }
  };

  const startSharing = (key: string) => {
    setSelectedKeys(new Set([key]));
    setSharing(true);
  };

  const toggleSelection = (key: string) => {
    setSelectedKeys((previous) => {
      const next = new Set(previous);
      if (next.has(key)) next.delete(key);
      else next.add(key);
      return next;
    });
  };

  const shareLabels = {
    title: tr("chat.message.exportTitle"),
    user: tr("chat.message.user"),
    assistant: tr("chat.message.assistant"),
  };

  const copySelected = async () => {
    if (!selectedMessages.length) return;
    try {
      await copyToClipboard(formatSharedText(selectedMessages, shareLabels));
      pushToast(tr("chat.message.textCopied"), "info");
    } catch {
      pushToast(tr("chat.message.copyFailed"), "error");
    }
  };

  const downloadSelectedHTML = () => {
    if (!selectedMessages.length) return;
    const blob = new Blob([formatSharedHTML(selectedMessages, shareLabels)], {
      type: "text/html;charset=utf-8",
    });
    const url = URL.createObjectURL(blob);
    const anchor = document.createElement("a");
    anchor.href = url;
    anchor.download = "kin-conversation.html";
    document.body.appendChild(anchor);
    anchor.click();
    anchor.remove();
    window.setTimeout(() => URL.revokeObjectURL(url), 0);
    pushToast(tr("chat.message.htmlDownloaded"), "info");
  };

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
    <div className="max-w-[720px] w-full min-w-0 mx-auto px-4 sm:px-7 flex flex-col gap-4">
      {sharing && (
        <ShareSelectionBar
          count={selectedMessages.length}
          onCancel={() => {
            setSharing(false);
            setSelectedKeys(new Set());
          }}
          onCopy={() => void copySelected()}
          onDownload={downloadSelectedHTML}
        />
      )}
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
                selectionMode={sharing}
                selected={selectedKeys.has(turn.item.key)}
                onToggleSelection={() => toggleSelection(turn.item.key)}
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
                model={turn.model}
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
                selectionMode={sharing}
                selectedKeys={selectedKeys}
                onToggleSelection={toggleSelection}
                onCopyMessage={(text) => void copyMessage(text)}
                onShareMessage={startSharing}
              />
            );
          }
        }
      })}

      {loadingStandalone && (
        <ThinkingRow speaker={loadingSpeaker} model={resolvedHostModel} />
      )}

      {trailing}
    </div>
  );
}

/** One left avatar for the whole agent reply after a user message. */
function AgentTurn({
  speaker,
  model,
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
  selectionMode = false,
  selectedKeys,
  onToggleSelection,
  onCopyMessage,
  onShareMessage,
}: {
  speaker: string;
  model?: string;
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
  selectionMode?: boolean;
  selectedKeys: Set<string>;
  onToggleSelection: (key: string) => void;
  onCopyMessage: (text: string) => void;
  onShareMessage: (key: string) => void;
}) {
  const tr = useT();
  const meta = agentAvatarMeta(speaker);
  // Show the name once at the top of the column (not on every sub-block).
  const hasPartial = items.some((i) => i.kind === "message" && i.partial);

  return (
    <div className="flex gap-2.5 items-start">
      <div
        className={`w-[28px] h-[28px] flex-none rounded-[8px] flex items-center justify-center text-[11px] font-bold ${meta.className}`}
        title={agentIdentityTitle(meta.label, model)}
      >
        {meta.initials}
      </div>
      <div className="flex-1 min-w-0 flex flex-col gap-2.5 pt-0.5">
        <div className="flex items-start gap-2">
          <AgentIdentity name={meta.label} model={model} />
          {hasPartial && (
            <span className="mt-px inline-flex items-center gap-1.5 text-[11px] text-kin-muted">
              <span className="w-1.5 h-1.5 rounded-full bg-kin-blue animate-breathe" />
              {tr("chat.streaming")}
            </span>
          )}
          {showThinking && !hasPartial && (
            <span className="mt-px text-[11px] text-kin-muted">
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
              const canCopy = !item.partial && item.text.trim().length > 0;
              return (
                <div
                  key={item.key}
                  className={[
                    "group/msg space-y-1 rounded-lg",
                    selectionMode && selectedKeys.has(item.key)
                      ? "ring-1 ring-kin-blue/40 bg-kin-blue-soft/20 p-2 -m-2"
                      : "",
                  ].join(" ")}
                >
                  {selectionMode && (
                    <MessageSelectionControl
                      role="assistant"
                      selected={selectedKeys.has(item.key)}
                      onToggle={() => onToggleSelection(item.key)}
                    />
                  )}
                  <MessageBody text={item.text} partial={item.partial} />
                  {(canRetryFork || canSave || canCopy) && (
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
                      {canCopy && (
                        <>
                          <button
                            type="button"
                            title={tr("chat.message.copyTitle")}
                            aria-label={tr("chat.message.copyTitle")}
                            onClick={() => onCopyMessage(item.text)}
                            className="inline-flex items-center gap-1 px-2 py-0.5 rounded-md text-[11.5px] font-medium text-kin-muted hover:text-kin-text hover:bg-black/[.05] dark:hover:bg-white/[.06]"
                          >
                            <IconCopy size={13} />
                            {tr("chat.message.copy")}
                          </button>
                          <button
                            type="button"
                            title={tr("chat.message.shareTitle")}
                            aria-label={tr("chat.message.shareTitle")}
                            onClick={() => onShareMessage(item.key)}
                            className="inline-flex items-center gap-1 px-2 py-0.5 rounded-md text-[11.5px] font-medium text-kin-muted hover:text-kin-text hover:bg-black/[.05] dark:hover:bg-white/[.06]"
                          >
                            <IconShare size={13} />
                            {tr("chat.message.share")}
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
  const tr = useT();
  if (item.kind === "error") {
    return (
      <div className="rounded-xl border border-kin-red/30 bg-[rgba(255,69,58,.08)] px-3.5 py-2.5 text-[13.5px] text-kin-red">
        {friendlyErrorLabel(item.message, tr)}
      </div>
    );
  }
  return (
    <p className="text-center text-[11.5px] text-kin-muted">{item.label}</p>
  );
}

/** Animated “thinking” row while waiting for the first assistant token. */
function ThinkingRow({
  speaker,
  model,
}: {
  speaker: string;
  model?: string;
}) {
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
        title={agentIdentityTitle(meta.label, model)}
      >
        {meta.initials}
      </div>
      <div className="flex-1 min-w-0 flex flex-col gap-1.5 pt-0.5">
        <div className="flex items-start gap-2">
          <AgentIdentity name={meta.label} model={model} />
          <span className="mt-px text-[11px] text-kin-muted">
            {tr("chat.thinking")}
          </span>
        </div>
        <ThinkingDots />
      </div>
    </div>
  );
}

function AgentIdentity({ name, model }: { name: string; model?: string }) {
  return (
    <span className="flex min-w-0 max-w-[70%] flex-col leading-none">
      <span className="truncate text-[12px] font-semibold leading-[14px] text-kin-text">
        {name}
      </span>
      {model && (
        <span
          className="mt-0.5 truncate font-mono text-[10px] font-normal leading-[12px] text-kin-muted/80"
          title={model}
        >
          {model}
        </span>
      )}
    </span>
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

  // Default collapsed so multi-tool runs don't dominate the transcript.
  // Auto-expand only while tools are actively running; collapse when they finish
  // unless the user manually toggled the card open.
  const [expanded, setExpanded] = useState(false);
  const [openStep, setOpenStep] = useState<string | null>(null);
  const scrollerRef = useRef<HTMLDivElement>(null);
  const wasRunning = useRef(running);
  const userToggled = useRef(false);

  useEffect(() => {
    if (running) {
      if (!userToggled.current) setExpanded(true);
      wasRunning.current = true;
    } else if (wasRunning.current) {
      // Just finished → collapse to summary (unless user pinned it open).
      if (!userToggled.current) setExpanded(false);
      setOpenStep(null);
      wasRunning.current = false;
      userToggled.current = false;
    }
  }, [running]);

  const stepsSig = steps
    .map((x) =>
      x.kind === "tool"
        ? `${x.key}:${x.status}:${x.summary ?? ""}`
        : `${x.key}:${x.status}:${(x.text ?? "").length}`,
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
      : `${agentDisplayName(latest.speaker)} · ${shorten(latest.text ?? "", 48)}`
    : "";

  return (
    <div
      className={`rounded-xl border ${statusTone} overflow-hidden`}
    >
      <button
        type="button"
        onClick={() => {
          userToggled.current = true;
          setExpanded((v) => !v);
        }}
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
  const noteText = note.text ?? "";
  const long = noteText.trim().length > 120 || noteText.includes("\n");
  const hasDetail = long || noteText.trim().length > 0;

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
          title={agentIdentityTitle(meta.label, note.model)}
        >
          {meta.initials}
        </span>
        <span className="flex w-[min(42%,12rem)] min-w-0 flex-none flex-col pt-px leading-none">
          <span className="truncate text-[11.5px] font-medium leading-[13px] text-kin-muted">
            {meta.label}
          </span>
          {note.model && (
            <span
              className="mt-0.5 truncate font-mono text-[9.5px] font-normal leading-[11px] text-kin-muted/70"
              title={note.model}
            >
              {note.model}
            </span>
          )}
        </span>
        <span className="flex-1 min-w-0 truncate text-kin-secondary">
          {shorten(noteText, 80)}
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
            <Markdown text={noteText} />
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

function formatToolJson(input: unknown): string {
  if (typeof input === "string") return input;
  try {
    return JSON.stringify(input, null, 2);
  } catch {
    return String(input);
  }
}

function shorten(s: string | null | undefined, max: number): string {
  const t = (s ?? "").replace(/\s+/g, " ").trim();
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
  const body = text ?? "";
  return (
    <div className="text-[14px] sm:text-[15px] leading-relaxed text-kin-text">
      <Markdown text={body} />
      {partial && !body.trim() && <ThinkingDots />}
      {partial && body.trim() && (
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
  selectionMode = false,
  selected = false,
  onToggleSelection,
}: {
  speaker: string;
  text: string;
  partial?: boolean;
  selectionMode?: boolean;
  selected?: boolean;
  onToggleSelection?: () => void;
}) {
  const tr = useT();
  const isUser = speaker === "user";
  const meta = agentAvatarMeta(speaker);

  if (isUser) {
    return (
      <div
        className={[
          // min-w-0: let this row shrink inside the chat column so max-w on
          // the bubble can actually constrain long unbroken paths/URLs.
          "flex min-w-0 w-full justify-end gap-2.5 items-start rounded-lg",
          selectionMode && selected
            ? "ring-1 ring-kin-blue/40 bg-kin-blue-soft/20 p-2 -m-2"
            : "",
        ].join(" ")}
      >
        <div className="min-w-0 max-w-[85%] sm:max-w-[78%] flex flex-col items-end gap-1">
          {selectionMode && (
            <MessageSelectionControl
              role="user"
              selected={selected}
              onToggle={onToggleSelection ?? (() => undefined)}
            />
          )}
          <div className="text-[11.5px] font-medium text-kin-muted px-1">
            {meta.label}
          </div>
          <div
            className="max-w-full min-w-0 px-3.5 py-2.5 rounded-[18px] rounded-br-[5px] text-[14px] sm:text-[15px] leading-relaxed whitespace-pre-wrap break-words [overflow-wrap:anywhere]"
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

function ShareSelectionBar({
  count,
  onCancel,
  onCopy,
  onDownload,
}: {
  count: number;
  onCancel: () => void;
  onCopy: () => void;
  onDownload: () => void;
}) {
  const tr = useT();
  const disabled = count === 0;
  return (
    <div
      className="sticky top-2 z-10 flex flex-wrap items-center gap-2 rounded-xl border border-kin-blue/30 bg-[var(--kin-elevated)]/95 px-3 py-2 shadow-sm backdrop-blur"
      role="region"
      aria-label={tr("chat.message.selection")}
    >
      <span className="mr-auto text-[12px] font-medium text-kin-text">
        {tr("chat.message.selected", { count })}
      </span>
      <button
        type="button"
        onClick={onCopy}
        disabled={disabled}
        className="inline-flex min-h-[32px] items-center gap-1 rounded-md bg-kin-blue px-2.5 py-1 text-[12px] font-medium text-white hover:bg-kin-blue/90 disabled:cursor-not-allowed disabled:opacity-40"
      >
        <IconCopy size={14} />
        {tr("chat.message.copyText")}
      </button>
      <button
        type="button"
        onClick={onDownload}
        disabled={disabled}
        className="inline-flex min-h-[32px] items-center gap-1 rounded-md border border-[var(--kin-hairline-strong)] px-2.5 py-1 text-[12px] font-medium text-kin-text hover:bg-[var(--kin-fill)] disabled:cursor-not-allowed disabled:opacity-40"
      >
        <IconDownload size={14} />
        {tr("chat.message.downloadHTML")}
      </button>
      <button
        type="button"
        onClick={onCancel}
        className="min-h-[32px] rounded-md px-2 py-1 text-[12px] font-medium text-kin-muted hover:bg-[var(--kin-fill)] hover:text-kin-text"
      >
        {tr("chat.message.cancel")}
      </button>
    </div>
  );
}

function MessageSelectionControl({
  role,
  selected,
  onToggle,
}: {
  role: "user" | "assistant";
  selected: boolean;
  onToggle: () => void;
}) {
  const tr = useT();
  const label = role === "user" ? tr("chat.message.user") : tr("chat.message.assistant");
  return (
    <label className="inline-flex w-fit cursor-pointer items-center gap-1.5 text-[11.5px] font-medium text-kin-muted">
      <input
        type="checkbox"
        checked={selected}
        onChange={onToggle}
        className="h-4 w-4 accent-[var(--kin-blue)]"
        aria-label={tr("chat.message.selectMessage", { role: label })}
      />
      {label}
    </label>
  );
}

async function copyToClipboard(text: string): Promise<void> {
  if (navigator.clipboard?.writeText) {
    try {
      await navigator.clipboard.writeText(text);
      return;
    } catch {
      // Some local / embedded contexts expose the API but deny permissions.
      // Fall through to the browser's legacy copy command in that case.
    }
  }

  const textarea = document.createElement("textarea");
  textarea.value = text;
  textarea.setAttribute("readonly", "");
  textarea.style.position = "fixed";
  textarea.style.opacity = "0";
  document.body.appendChild(textarea);
  textarea.select();
  const copied = document.execCommand("copy");
  textarea.remove();
  if (!copied) throw new Error("clipboard unavailable");
}

function agentIdentityTitle(name: string, model?: string): string {
  return model ? `${name} · ${model}` : name;
}
