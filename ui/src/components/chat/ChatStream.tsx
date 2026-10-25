/**
 * Single-column chat transcript.
 * One user message → one agent reply column (single left avatar). Intermediate
 * multi-agent / tool steps remain as a complete, ordered execution record.
 */
import { useEffect, useMemo, useState, type ReactNode } from "react";
import type { TaskEvent } from "../../api/client";
import { extractPrimaryToolPath } from "../../lib/changedFiles";
import { shortPath } from "../../lib/paths";
import { friendlyErrorLabel } from "../../lib/friendlyError";
import { useLocale, useT } from "../../i18n/react";
import { isMessageQueued } from "../../lib/queuedPrompts";
import { agentAvatarMeta } from "../../lib/agentMention";
import { useAppStore } from "../../store/appStore";
import { IconCopy, IconDownload, IconShare } from "../icons";
import Markdown from "../Markdown";
import { formatSharedHTML, formatSharedText, type SharedMessage } from "./shareExport";
import {
  buildChatItems,
  findSpeakerModel,
  groupIntoTurns,
  isProgressCardRunning,
  mergeProcessRuns,
  normalizeModel,
  prettyToolName,
  shouldShowGenericThinking,
  summarizeProgressDetails,
  summarizeProgressStatus,
  type ChatItem,
  type NoteStep,
  type ProgressItem,
  type ToolStep,
} from "./transcriptProjection";

/** One empty set, shared: the default for a stream that has no queue to show. */
const EMPTY_QUEUED: Set<number> = new Set();

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
  /**
   * Seqs of the messages that are still waiting for a turn (the daemon's queue).
   * A message in here is in the transcript already; this only marks it.
   */
  queuedSeqs?: Set<number>;
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
  queuedSeqs,
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
  const [selectedKeys, setSelectedKeys] = useState<Set<string>>(() => new Set());
  // Rebuild when locale changes (tool summaries use t()).
  const items = useMemo(
    () => mergeProcessRuns(buildChatItems(events, hostSpeaker, hostModel, !loading)),
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
  const hasUserMsg = items.some((i) => i.kind === "message" && i.speaker === "user");
  const selectableMessages = useMemo(
    () =>
      items.filter(
        (item): item is Extract<ChatItem, { kind: "message" }> =>
          item.kind === "message" && !item.partial && item.text.trim().length > 0,
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
      const next = new Set([...previous].filter((key) => selectableKeys.has(key)));
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

  const showLoading = shouldShowGenericThinking(items, loading);

  // If the last turn is already an agent column, fold thinking into it so we
  // don't paint a second Kin avatar under the same user message.
  const lastTurn = turns[turns.length - 1];
  const loadingInsideAgent = showLoading && lastTurn?.kind === "agent";
  const loadingStandalone = showLoading && !loadingInsideAgent;

  return (
    <div className="max-w-conversation w-full min-w-0 mx-auto px-4 sm:px-7 flex flex-col gap-4">
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
        <MessageRow speaker="user" text={fallbackUserPrompt} partial={false} />
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
                queued={isMessageQueued(turn.item.seq, queuedSeqs ?? EMPTY_QUEUED)}
                selectionMode={sharing}
                selected={selectedKeys.has(turn.item.key)}
                onToggleSelection={() => toggleSelection(turn.item.key)}
              />
            );
          case "standalone":
            return <StandaloneRow key={turn.item.key} item={turn.item} />;
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

      {loadingStandalone && <ThinkingRow speaker={loadingSpeaker} model={resolvedHostModel} />}

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
        className={`w-[28px] h-[28px] flex-none rounded-lg flex items-center justify-center text-caption font-bold ${meta.className}`}
        title={agentIdentityTitle(meta.label, model)}
      >
        {meta.initials}
      </div>
      <div className="flex-1 min-w-0 flex flex-col gap-2.5 pt-0.5">
        <div className="flex items-start gap-2">
          <AgentIdentity name={meta.label} model={model} />
          {hasPartial && (
            <span className="mt-px inline-flex items-center gap-1.5 text-caption text-kin-muted">
              <span className="w-1.5 h-1.5 rounded-full bg-kin-blue animate-breathe" />
              {tr("chat.streaming")}
            </span>
          )}
          {showThinking && !hasPartial && (
            <span className="mt-px text-caption text-kin-muted">{tr("chat.thinking")}</span>
          )}
        </div>

        {items.map((item) => {
          switch (item.kind) {
            case "message": {
              const canSave = !!onSaveArtifact && !item.partial && item.text.trim().length > 0;
              const canRetryFork =
                showMessageActions && !item.partial && typeof item.seq === "number";
              const canCopy = !item.partial && item.text.trim().length > 0;
              return (
                <div
                  key={item.key}
                  className={[
                    "group/msg space-y-1 rounded-lg",
                    selectionMode && selectedKeys.has(item.key)
                      ? "ring-1 ring-kin-blue/40 bg-kin-blue/15 p-2 -m-2"
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
                            className="px-2 py-0.5 rounded-md text-caption font-medium text-kin-muted hover:text-kin-text  hover:bg-kin-fill disabled:opacity-40"
                          >
                            {tr("task.retry")}
                          </button>
                          <button
                            type="button"
                            disabled={actionsBusy}
                            title={tr("task.forkTitle")}
                            onClick={() => onFork?.(item.seq!)}
                            className="px-2 py-0.5 rounded-md text-caption font-medium text-kin-muted hover:text-kin-text  hover:bg-kin-fill disabled:opacity-40"
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
                            className="inline-flex items-center gap-1 px-2 py-0.5 rounded-md text-caption font-medium text-kin-muted hover:text-kin-text  hover:bg-kin-fill"
                          >
                            <IconCopy size={13} />
                            {tr("chat.message.copy")}
                          </button>
                          <button
                            type="button"
                            title={tr("chat.message.shareTitle")}
                            aria-label={tr("chat.message.shareTitle")}
                            onClick={() => onShareMessage(item.key)}
                            className="inline-flex items-center gap-1 px-2 py-0.5 rounded-md text-caption font-medium text-kin-muted hover:text-kin-text  hover:bg-kin-fill"
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
                          className="px-2 py-0.5 rounded-md text-caption font-medium text-kin-muted hover:text-kin-text  hover:bg-kin-fill disabled:opacity-40"
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
              return (
                <ProgressCard
                  key={item.key}
                  item={item}
                  running={isProgressCardRunning(allItems, item, loading)}
                  onOpenPath={onOpenPath}
                />
              );
            }
            case "error":
              return (
                <div
                  key={item.key}
                  className="rounded-xl border border-kin-red/30 bg-kin-red/10 px-3.5 py-2.5 text-strong text-kin-red-ink"
                >
                  {item.message}
                </div>
              );
            case "meta":
              return (
                <p key={item.key} className="text-caption text-kin-muted">
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

function StandaloneRow({ item }: { item: Extract<ChatItem, { kind: "error" | "meta" }> }) {
  const tr = useT();
  if (item.kind === "error") {
    return (
      <div className="rounded-xl border border-kin-red/30 bg-kin-red/10 px-3.5 py-2.5 text-strong text-kin-red-ink">
        {friendlyErrorLabel(item.message, tr)}
      </div>
    );
  }
  return <p className="text-center text-caption text-kin-muted">{item.label}</p>;
}

/** Animated “thinking” row while waiting for the first assistant token. */
function ThinkingRow({ speaker, model }: { speaker: string; model?: string }) {
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
        className={`w-[28px] h-[28px] flex-none rounded-lg flex items-center justify-center text-caption font-bold ${meta.className}`}
        title={agentIdentityTitle(meta.label, model)}
      >
        {meta.initials}
      </div>
      <div className="flex-1 min-w-0 flex flex-col gap-1.5 pt-0.5">
        <div className="flex items-start gap-2">
          <AgentIdentity name={meta.label} model={model} />
          <span className="mt-px text-caption text-kin-muted">{tr("chat.thinking")}</span>
        </div>
        <ThinkingDots />
      </div>
    </div>
  );
}

function AgentIdentity({ name, model }: { name: string; model?: string }) {
  return (
    <span className="flex min-w-0 max-w-[70%] flex-col leading-flush">
      <span className="truncate text-body font-semibold leading-4 text-kin-text">{name}</span>
      {model && (
        <span
          className="mt-0.5 truncate font-mono text-micro font-normal leading-3 text-kin-muted/80"
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

/** Full execution transcript. Avatar and identity are owned by AgentTurn. */
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
  const [collapsed, setCollapsed] = useState(true);
  const [openStep, setOpenStep] = useState<string | null>(null);
  const details = summarizeProgressDetails(steps);
  const status = summarizeProgressStatus(steps, running);
  const activity = details.toolCounts || tr("chat.progress.notes", { count: details.noteCount });

  const summary = (() => {
    if (status.state === "running") {
      return tr("chat.progress.summaryRunning", { activity });
    }
    if (status.state === "failed") {
      return tr("chat.progress.summaryFailed", { activity });
    }
    if (status.state === "partial_failed") {
      return tr("chat.progress.summaryMixed", {
        done: status.doneTools,
        failed: status.failedTools,
        activity,
      });
    }
    return tr("chat.progress.summaryDone", { activity });
  })();

  const failed = status.state === "failed";
  const partialFailed = status.state === "partial_failed";
  const statusTone =
    // 15% is the ceiling for a status tint that carries ink — the card's own
    // step rows are `text-kin-muted`, and at 30% that caption measured 3.8:1 in
    // the light scheme. See `tokens.test.ts`, "certifies every ink on a tint".
    status.state === "running"
      ? "border-kin-blue/25 bg-kin-blue/15"
      : failed || partialFailed
        ? "border-kin-red/25 bg-kin-red/5"
        : "border-[var(--kin-hairline)] bg-[var(--kin-fill)]";

  const badgeLabel =
    status.state === "running"
      ? tr("chat.progress.running")
      : failed
        ? tr("chat.progress.failed")
        : partialFailed
          ? tr("chat.progress.partialFailed")
          : tr("chat.progress.done");

  const badgeTone =
    status.state === "running"
      ? "bg-kin-blue/15 text-kin-blue-ink"
      : failed || partialFailed
        ? "bg-kin-red/15 text-kin-red-ink"
        : "bg-[var(--kin-fill-strong)] text-kin-muted";

  return (
    <div className={`rounded-xl border ${statusTone} overflow-hidden`}>
      <button
        type="button"
        onClick={() => setCollapsed((v) => !v)}
        aria-expanded={!collapsed}
        className="flex items-center gap-2 w-full px-3 py-2 text-body text-left cursor-pointer hover:bg-[var(--kin-fill-strong)] transition-colors"
      >
        <span
          className={[
            "flex-none text-micro font-semibold uppercase tracking-label px-1.5 py-0.5 rounded",
            badgeTone,
          ].join(" ")}
        >
          {status.state === "running" ? (
            <span className="inline-flex items-center gap-1">
              <span className="w-1.5 h-1.5 rounded-full bg-kin-blue animate-breathe" />
              {badgeLabel}
            </span>
          ) : (
            badgeLabel
          )}
        </span>
        <span className="flex min-w-0 flex-1 flex-col gap-0.5">
          <span className="break-words font-medium text-kin-text">{summary}</span>
          {collapsed && details.latestNote && (
            <span
              className="truncate text-caption font-normal text-kin-muted"
              title={details.latestNote}
            >
              {details.latestNote}
            </span>
          )}
        </span>
        <span className="flex-none text-caption font-normal text-kin-muted">
          {collapsed ? tr("chat.progress.expand") : tr("chat.progress.hide")}
        </span>
      </button>
      {!collapsed && (
        // `divide-y` separates the rows from each other, and this line separates
        // the first of them from the summary above — the two faces are the same
        // level, so the rule draws it. The tint below is not a level, and how
        // far it is from one depends on the tone: the numbers here are the
        // *settled* card (`--kin-fill`), where 30% `--kin-elevated` composites
        // to exactly the card's value in the light scheme (245,245,245 on
        // 245,245,245) and to one 8-bit step in the dark one. Measured across
        // the three tones the separation runs 0.00 L* (light, settled) to 2.08
        // (dark, failed, whose `--kin-red/5` card is the one the tint actually
        // moves away from), so the tint cannot be relied on for the boundary in
        // any of them — which is why removing this border left the header and
        // the first step running together in both schemes.
        <div className="border-t border-[var(--kin-hairline)] bg-kin-elevated/30 divide-y divide-[var(--kin-hairline)]">
          {steps.map((step, idx) =>
            step.kind === "tool" ? (
              <ToolStepRow
                key={step.key}
                tool={step}
                index={idx + 1}
                open={openStep === step.key}
                onOpenPath={onOpenPath}
                onToggle={() => setOpenStep((cur) => (cur === step.key ? null : step.key))}
              />
            ) : (
              <NoteStepRow key={step.key} note={step} index={idx + 1} />
            ),
          )}
        </div>
      )}
    </div>
  );
}

function NoteStepRow({ note, index }: { note: NoteStep; index: number }) {
  const tr = useT();
  const statusDot =
    // A status dot is a pigment, and the failure branch has to be one: the
    // neutral `--kin-fill-strong` wash this used to carry measured 1.4:1
    // against the card it sits in, and it was the row's only failure signal.
    note.status === "error"
      ? "bg-kin-red"
      : note.status === "running"
        ? "bg-kin-blue animate-breathe"
        : "bg-kin-green";
  return (
    <div className="flex items-start gap-2 px-3 py-1.5 text-body">
      <span className="flex-none w-5 text-caption tabular-nums text-kin-muted pt-0.5">{index}</span>
      <span className={`mt-1.5 w-1.5 h-1.5 rounded-full flex-none ${statusDot}`} />
      <span className="font-mono text-caption text-kin-muted flex-none pt-px">
        {tr("chat.progress.note")}
      </span>
      <span className="flex-1 min-w-0 whitespace-pre-wrap break-words text-kin-secondary">
        {note.text}
      </span>
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

/** Message body only (avatar / name owned by AgentTurn for assistants). */
function MessageBody({ text, partial }: { text: string; partial?: boolean }) {
  const body = text ?? "";
  return (
    <div className="text-strong sm:text-subtitle leading-prose text-kin-text">
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
  queued = false,
  selectionMode = false,
  selected = false,
  onToggleSelection,
}: {
  speaker: string;
  text: string;
  partial?: boolean;
  /** Still waiting for a turn: the daemon has it queued, not answered. */
  queued?: boolean;
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
          selectionMode && selected ? "ring-1 ring-kin-blue/40 bg-kin-blue/15 p-2 -m-2" : "",
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
          <div className="flex items-center gap-1.5 px-1">
            <div className="text-caption font-medium text-kin-muted">{meta.label}</div>
            {queued && (
              <span className="inline-flex items-center gap-1 rounded-full bg-kin-blue/15 px-1.5 py-px text-caption font-medium text-kin-blue-ink">
                <span className="w-1.5 h-1.5 rounded-full bg-kin-blue animate-breathe" />
                {tr("chat.queued")}
              </span>
            )}
          </div>
          <div
            className="max-w-full min-w-0 px-3.5 py-2.5 rounded-2xl rounded-br-md text-strong sm:text-subtitle leading-prose whitespace-pre-wrap break-words [overflow-wrap:anywhere]"
            style={{
              background: "var(--kin-bubble-user)",
              // The user's bubble is a brand fill, so it takes the brand
              // foreground. `--kin-bubble-user-fg` used to be a token of its
              // own holding the same value — one fill, one foreground.
              color: "var(--kin-on-brand)",
            }}
          >
            {text}
          </div>
        </div>
        <div
          className={`w-[28px] h-[28px] flex-none rounded-full flex items-center justify-center text-caption font-bold ${meta.className}`}
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
        className={`w-[28px] h-[28px] flex-none rounded-lg flex items-center justify-center text-caption font-bold ${meta.className}`}
        title={meta.label}
      >
        {meta.initials}
      </div>
      <div className="flex-1 min-w-0 flex flex-col gap-1 pt-0.5">
        <div className="flex items-center gap-2">
          <span className="text-body font-semibold text-kin-text">{meta.label}</span>
          {partial && (
            <span className="inline-flex items-center gap-1.5 text-caption text-kin-muted">
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
      className="sticky top-2 z-10 flex flex-wrap items-center gap-2 rounded-xl border border-kin-blue/30 bg-kin-elevated/95 px-3 py-2 shadow-e1 backdrop-blur"
      role="region"
      aria-label={tr("chat.message.selection")}
    >
      <span className="mr-auto text-body font-medium text-kin-text">
        {tr("chat.message.selected", { count })}
      </span>
      <button
        type="button"
        onClick={onCopy}
        disabled={disabled}
        className="inline-flex min-h-8 items-center gap-1 rounded-md bg-kin-blue px-2.5 py-1 text-body font-medium text-kin-on-brand hover:bg-kin-blue/90 disabled:cursor-not-allowed disabled:opacity-40"
      >
        <IconCopy size={14} />
        {tr("chat.message.copyText")}
      </button>
      <button
        type="button"
        onClick={onDownload}
        disabled={disabled}
        className="inline-flex min-h-8 items-center gap-1 rounded-md border border-[var(--kin-hairline-strong)] px-2.5 py-1 text-body font-medium text-kin-text hover:bg-[var(--kin-fill)] disabled:cursor-not-allowed disabled:opacity-40"
      >
        <IconDownload size={14} />
        {tr("chat.message.downloadHTML")}
      </button>
      <button
        type="button"
        onClick={onCancel}
        className="min-h-8 rounded-md px-2 py-1 text-body font-medium text-kin-muted hover:bg-[var(--kin-fill)] hover:text-kin-text"
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
    <label className="inline-flex w-fit cursor-pointer items-center gap-1.5 text-caption font-medium text-kin-muted">
      <input
        type="checkbox"
        checked={selected}
        onChange={onToggle}
        className="h-4 w-4 accent-kin-blue"
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
