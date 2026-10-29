/**
 * Single-column chat transcript.
 * One user message → one agent reply column (single left avatar). Intermediate
 * multi-agent / tool steps remain as a complete, ordered execution record.
 */
import {
  Fragment,
  memo,
  useCallback,
  useEffect,
  useMemo,
  useRef,
  useState,
  type MouseEvent as ReactMouseEvent,
  type ReactNode,
} from "react";
import type { TaskEvent } from "../../api/client";
import { findMatches, stepMatch } from "../../lib/findInTranscript";
import { friendlyErrorLabel } from "../../lib/friendlyError";
import { useLocale, useT } from "../../i18n/react";
import { isMessageQueued } from "../../lib/queuedPrompts";
import { agentAvatarMeta } from "../../lib/agentMention";
import {
  isMessageActionsToggleTap,
  toggleMobileMessageActions,
  useMobileMessageActionsRevealed,
} from "../../lib/mobileMessageActions";
import { useAppStore } from "../../store/appStore";
import { IconChevron, IconCopy, IconDownload, IconSearch, IconShare, IconX } from "../icons";
import Markdown from "../Markdown";
import RoundEvidenceCard from "./RoundEvidenceCard";
import ToolStepRow from "./ToolStepRow";
import { formatSharedHTML, formatSharedText, type SharedMessage } from "./shareExport";
import {
  buildChatItems,
  findSpeakerModel,
  groupIntoTurns,
  isProgressCardRunning,
  mergeProcessRuns,
  noteLabelKey,
  noteNeedsAttribution,
  normalizeModel,
  progressRows,
  roundEvidenceByTurn,
  shouldShowGenericThinking,
  summarizeProgressDetails,
  summarizeProgressStatus,
  type ChatItem,
  type NoteStep,
  type ProgressItem,
  type Turn,
} from "./transcriptProjection";

/** One empty set, shared: the default for a stream that has no queue to show. */
const EMPTY_QUEUED: Set<number> = new Set();

/** One empty result, shared: a closed find bar has nothing to point at. */
const NO_FIND_HITS: readonly string[] = [];

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
  /**
   * Take back a queued message before it is delivered, given the seq of the
   * message it belongs to. Undefined hides the control — a reader who cannot
   * send to this task has nothing to withdraw, and neither has one looking at a
   * transcript that is not live.
   */
  onUnqueue?: (seq: number) => void;
  /**
   * Take a queued message back out of the queue and put its text in the
   * composer, given the seq of the message it belongs to. Undefined hides the
   * control for the same reason `onUnqueue` does.
   */
  onEditQueued?: (seq: number) => void;
  /**
   * Scopes the mobile message-actions reveal. Message keys are `t-<seq>`, and
   * seq restarts per task while several sessions stay mounted (the tab host),
   * so without a task id one revealed message would light up the same-named
   * message in every other session.
   */
  messageScope?: string;
  /**
   * Cards to render in the conversation, keyed by the id of the request they
   * answer. A request whose event is in this list is drawn where it was asked
   * instead of at the end of the stream.
   */
  pendingSlots?: Record<string, ReactNode>;
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
  /**
   * Find bar, controlled. The phone has no Cmd+F, so its session menu has to be
   * able to open the bar; leaving this undefined keeps the state internal and
   * the keyboard shortcut is the only way in (the desktop answer).
   */
  findOpen?: boolean;
  onFindOpenChange?: (open: boolean) => void;
  /**
   * Whether this instance may claim Cmd/Ctrl+F. Sessions stay mounted behind
   * the tab strip (display:none), so without this every hidden pane would open
   * its own bar on one shortcut.
   */
  findShortcut?: boolean;
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
  onUnqueue,
  onEditQueued,
  messageScope = "",
  pendingSlots,
  showMessageActions = false,
  actionsBusy = false,
  onRetry,
  onFork,
  onSaveArtifact,
  onOpenPath,
  findOpen: findOpenProp,
  onFindOpenChange,
  findShortcut = true,
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
  // What each round changed, keyed by the turn it ends on — the one the card is
  // drawn under. The join itself is a projection rule and lives with the others.
  const evidenceByTurn = useMemo(() => roundEvidenceByTurn(events, turns), [turns, events]);

  // --- Find in conversation -------------------------------------------------
  const [findOpenSelf, setFindOpenSelf] = useState(false);
  const findOpen = findOpenProp ?? findOpenSelf;
  const [findQuery, setFindQuery] = useState("");
  const [findIndex, setFindIndex] = useState(0);
  // Bumped by every step, so a next/prev that lands on the only hit still
  // re-centres after the reader has scrolled away from it.
  const [findNav, setFindNav] = useState(0);
  const rootRef = useRef<HTMLDivElement | null>(null);
  const findInputRef = useRef<HTMLInputElement | null>(null);
  const findReturnFocusRef = useRef<HTMLElement | null>(null);

  const setFindOpen = useCallback(
    (open: boolean) => {
      setFindOpenSelf(open);
      onFindOpenChange?.(open);
    },
    [onFindOpenChange],
  );

  // Nothing to count while the bar is shut, and a closed bar must leave no ring
  // behind: the hits, and with them the active key, exist only while it is open.
  const findHits = useMemo(() => {
    if (!findOpen) return NO_FIND_HITS;
    // Only message bubbles carry text a reader would search for; progress cards
    // and error rows are labels, not content. Partial messages stream, so they
    // are matched as they stand rather than being frozen out until they finish.
    const messages = items.filter(
      (item): item is Extract<ChatItem, { kind: "message" }> =>
        item.kind === "message" && item.text.trim().length > 0,
    );
    return findMatches(messages, findQuery);
  }, [findOpen, items, findQuery]);
  // `stepMatch` normalises, so a query that loses hits under a streaming edit
  // cannot leave the bar pointing past the end of its own result set.
  const findActiveIndex = stepMatch(findIndex, 0, findHits.length);
  const activeFindKey = findActiveIndex >= 0 ? findHits[findActiveIndex] : null;

  useEffect(() => {
    if (findOpen) {
      const previous = document.activeElement;
      findReturnFocusRef.current =
        previous instanceof HTMLElement && previous !== document.body ? previous : null;
      findInputRef.current?.focus();
      findInputRef.current?.select();
      return;
    }
    // Closing hands focus back where it was; left alone it lands on <body>, and
    // a keyboard user has to Tab in from the top of the page again.
    const previous = findReturnFocusRef.current;
    findReturnFocusRef.current = null;
    previous?.focus?.();
  }, [findOpen]);

  useEffect(() => {
    if (!findOpen || !activeFindKey) return;
    const root = rootRef.current;
    if (!root) return;
    // Attribute compared against attribute rather than built into a selector:
    // our keys need no escaping today, and this cannot start needing it.
    const target = Array.from(root.querySelectorAll<HTMLElement>("[data-message-key]")).find(
      (element) => element.getAttribute("data-message-key") === activeFindKey,
    );
    target?.scrollIntoView?.({ block: "center", behavior: "smooth" });
  }, [findOpen, activeFindKey, findNav]);

  useEffect(() => {
    if (!findShortcut) return;
    const onKeyDown = (event: KeyboardEvent) => {
      // Escape during IME composition cancels the composition, not the bar.
      if (event.isComposing) return;
      if ((event.metaKey || event.ctrlKey) && !event.altKey && event.key.toLowerCase() === "f") {
        event.preventDefault();
        setFindOpen(true);
        findInputRef.current?.focus();
        findInputRef.current?.select();
        return;
      }
      if (!findOpen || event.key !== "Escape") return;
      // "One Escape, one layer." A mention menu, the command palette or a sheet
      // claims the key with `preventDefault`, and the palette's listener is also
      // on window and registered after this one — so the claim only exists once
      // the dispatch is over. Hence the task boundary rather than a check here.
      window.setTimeout(() => {
        if (event.defaultPrevented) return;
        event.preventDefault();
        setFindOpen(false);
      }, 0);
    };
    window.addEventListener("keydown", onKeyDown);
    return () => window.removeEventListener("keydown", onKeyDown);
  }, [findOpen, findShortcut, setFindOpen]);

  const stepFind = (delta: number) => {
    // Enter in an empty result set is not "go to match -1": a negative ordinal
    // would land on the last match as soon as one streams in.
    if (findHits.length === 0) return;
    setFindIndex((index) => stepMatch(index, delta, findHits.length));
    setFindNav((nav) => nav + 1);
  };

  const findStatus = !findQuery.trim()
    ? ""
    : findHits.length > 0
      ? tr("chat.find.count", { index: findActiveIndex + 1, total: findHits.length })
      : tr("chat.find.noMatches");

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

  /**
   * One turn, drawn. A function rather than an inline switch so a round's
   * evidence card can be placed after the turn that round ends on without
   * wrapping that turn's own markup in an element of its own.
   */
  function renderTurn(turn: Turn, turnIdx: number): ReactNode {
    switch (turn.kind) {
      case "user": {
        const seq = turn.item.seq;
        const queued = isMessageQueued(seq, queuedSeqs ?? EMPTY_QUEUED);
        return (
          <MessageRow
            key={turn.item.key}
            messageKey={turn.item.key}
            activeFindKey={activeFindKey}
            speaker={turn.item.speaker}
            text={turn.item.text}
            partial={turn.item.partial}
            queued={queued}
            // Whether the control may show at all is the row's call: it is the
            // one place that knows the message is still waiting.
            onUnqueue={onUnqueue && seq !== undefined ? () => onUnqueue(seq) : undefined}
            onEditQueued={onEditQueued && seq !== undefined ? () => onEditQueued(seq) : undefined}
            selectionMode={sharing}
            selected={selectedKeys.has(turn.item.key)}
            onToggleSelection={() => toggleSelection(turn.item.key)}
          />
        );
      }
      case "standalone":
        return (
          <StandaloneRow
            key={turn.item.key}
            item={turn.item}
            slot={
              turn.item.kind === "meta" ? pendingSlots?.[turn.item.pending?.id ?? ""] : undefined
            }
          />
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
            hostSpeaker={hostSpeaker}
            pendingSlots={pendingSlots}
            loading={loading}
            allItems={items}
            showThinking={withThinking}
            messageScope={messageScope}
            showMessageActions={showMessageActions}
            actionsBusy={actionsBusy}
            onRetry={onRetry}
            onFork={onFork}
            onSaveArtifact={onSaveArtifact}
            onOpenPath={onOpenPath}
            activeFindKey={activeFindKey}
            selectionMode={sharing}
            selectedKeys={selectedKeys}
            onToggleSelection={toggleSelection}
            onCopyMessage={(text) => void copyMessage(text)}
            onShareMessage={startSharing}
          />
        );
      }
    }
    return null;
  }

  return (
    <div
      ref={rootRef}
      className="max-w-conversation w-full min-w-0 mx-auto px-4 sm:px-7 flex flex-col gap-4"
    >
      {findOpen && (
        <div
          role="search"
          aria-label={tr("chat.find.label")}
          className="sticky top-0 z-20 -mx-4 -mt-1 flex items-center gap-1.5 border-b border-[var(--kin-hairline)] bg-[var(--kin-page)] px-4 py-2 sm:-mx-7 sm:px-7"
        >
          <div className="flex min-h-9 min-w-0 flex-1 items-center gap-1.5 rounded-full bg-[var(--kin-fill)] pl-2.5 pr-1 focus-within:ring-2 focus-within:ring-kin-focus-ring">
            <IconSearch size={14} className="flex-none text-kin-muted" />
            <input
              ref={findInputRef}
              value={findQuery}
              onChange={(event) => {
                setFindQuery(event.target.value);
                // A new query starts its walk at the first hit, including when
                // it narrows an old one: keeping the ordinal would land
                // mid-list on an unrelated match.
                setFindIndex(0);
              }}
              onKeyDown={(event) => {
                // Enter that confirms an IME candidate is not "next match".
                if (event.nativeEvent.isComposing) return;
                if (event.key === "Enter") {
                  event.preventDefault();
                  stepFind(event.shiftKey ? -1 : 1);
                }
              }}
              placeholder={tr("chat.find.placeholder")}
              aria-label={tr("chat.find.label")}
              type="text"
              enterKeyHint="search"
              className="min-h-9 min-w-0 flex-1 appearance-none bg-transparent text-body text-kin-text outline-none placeholder:text-kin-muted"
            />
          </div>
          <span
            className="flex-none whitespace-nowrap text-caption tabular-nums text-kin-muted"
            aria-live="polite"
          >
            {findStatus}
          </span>
          <button
            type="button"
            onClick={() => stepFind(-1)}
            disabled={findHits.length === 0}
            aria-label={tr("chat.find.prev")}
            title={tr("chat.find.prev")}
            className="flex h-8 w-8 flex-none items-center justify-center rounded-full text-kin-muted hover:bg-[var(--kin-fill)] hover:text-kin-text disabled:opacity-40"
          >
            <IconChevron size={15} className="-rotate-90" />
          </button>
          <button
            type="button"
            onClick={() => stepFind(1)}
            disabled={findHits.length === 0}
            aria-label={tr("chat.find.next")}
            title={tr("chat.find.next")}
            className="flex h-8 w-8 flex-none items-center justify-center rounded-full text-kin-muted hover:bg-[var(--kin-fill)] hover:text-kin-text disabled:opacity-40"
          >
            <IconChevron size={15} className="rotate-90" />
          </button>
          <button
            type="button"
            onClick={() => setFindOpen(false)}
            aria-label={tr("chat.find.close")}
            title={tr("chat.find.close")}
            className="flex h-8 w-8 flex-none items-center justify-center rounded-full text-kin-muted hover:bg-[var(--kin-fill)] hover:text-kin-text"
          >
            <IconX size={15} />
          </button>
        </div>
      )}
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
        const rendered = renderTurn(turn, turnIdx);
        const evidence = evidenceByTurn.get(turn);
        if (!evidence) return rendered;
        // A keyed fragment, so the card is the turn's sibling rather than its
        // child: nothing inside the turn changes to make room for it.
        return (
          <Fragment key={`round-${turnIdx}`}>
            {rendered}
            <RoundEvidenceCard evidence={evidence} onOpenPath={onOpenPath} />
          </Fragment>
        );
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
  hostSpeaker,
  pendingSlots,
  loading,
  allItems,
  showThinking,
  messageScope = "",
  showMessageActions = false,
  actionsBusy = false,
  onRetry,
  onFork,
  onSaveArtifact,
  onOpenPath,
  activeFindKey,
  selectionMode = false,
  selectedKeys,
  onToggleSelection,
  onCopyMessage,
  onShareMessage,
}: {
  speaker: string;
  model?: string;
  items: ChatItem[];
  /** The session's host agent, which is what a step's attribution compares to. */
  hostSpeaker: string;
  /** Pending cards by id: an asking event inside this column draws its own. */
  pendingSlots?: Record<string, ReactNode>;
  loading: boolean;
  allItems: ChatItem[];
  showThinking: boolean;
  /** See ChatStream's `messageScope`. */
  messageScope?: string;
  showMessageActions?: boolean;
  actionsBusy?: boolean;
  onRetry?: (fromSeq: number) => void;
  onFork?: (fromSeq: number) => void;
  onSaveArtifact?: (text: string) => void;
  onOpenPath?: (path: string) => void;
  /** The message the find bar is pointing at, if any. */
  activeFindKey?: string | null;
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
            case "message":
              return (
                <AssistantMessageItem
                  key={item.key}
                  item={item}
                  messageScope={messageScope}
                  showMessageActions={showMessageActions}
                  actionsBusy={actionsBusy}
                  onRetry={onRetry}
                  onFork={onFork}
                  onSaveArtifact={onSaveArtifact}
                  activeFindKey={activeFindKey}
                  selectionMode={selectionMode}
                  selected={selectedKeys.has(item.key)}
                  onToggleSelection={() => onToggleSelection(item.key)}
                  onCopyMessage={onCopyMessage}
                  onShareMessage={onShareMessage}
                />
              );
            case "progress": {
              return (
                <ProgressCard
                  key={item.key}
                  item={item}
                  hostSpeaker={hostSpeaker}
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
            case "meta": {
              // An asking event almost never starts a turn of its own: the agent
              // narrates, then stops to ask, so the grouping folds it into the
              // column above. The card has to be drawn here too, or the one place
              // it was anchored is the one place it never appears.
              const slot = item.pending ? pendingSlots?.[item.pending.id] : undefined;
              if (slot) return <Fragment key={item.key}>{slot}</Fragment>;
              return (
                <p key={item.key} className="text-caption text-kin-muted">
                  {item.label}
                </p>
              );
            }
          }
        })}

        {showThinking && !hasPartial && <ThinkingDots />}
      </div>
    </div>
  );
}

/**
 * One assistant message and its action row. A component of its own because
 * the mobile reveal is per-message state (`useMobileMessageActionsRevealed`),
 * and a hook has to live in a component, not in a map callback.
 */
export type AssistantMessageItemProps = {
  item: Extract<ChatItem, { kind: "message" }>;
  messageScope?: string;
  showMessageActions: boolean;
  actionsBusy: boolean;
  onRetry?: (fromSeq: number) => void;
  onFork?: (fromSeq: number) => void;
  onSaveArtifact?: (text: string) => void;
  /** See ChatStream's find bar; the active hit is the one drawn with a ring. */
  activeFindKey?: string | null;
  selectionMode: boolean;
  selected: boolean;
  onToggleSelection: () => void;
  onCopyMessage: (text: string) => void;
  onShareMessage: (key: string) => void;
};

const AssistantMessageItem = memo(function AssistantMessageItem({
  item,
  messageScope = "",
  showMessageActions,
  actionsBusy,
  onRetry,
  onFork,
  onSaveArtifact,
  activeFindKey,
  selectionMode,
  selected,
  onToggleSelection,
  onCopyMessage,
  onShareMessage,
}: AssistantMessageItemProps) {
  const tr = useT();
  const canSave = !!onSaveArtifact && !item.partial && item.text.trim().length > 0;
  const canRetryFork = showMessageActions && !item.partial && typeof item.seq === "number";
  const canCopy = !item.partial && item.text.trim().length > 0;
  // The store is module-level, so the key must name the task as well as the
  // message: several sessions stay mounted (tab host), and their seqs collide.
  const storeKey = messageScope ? `${messageScope}:${item.key}` : item.key;
  const revealed = useMobileMessageActionsRevealed(storeKey);
  return (
    <div
      data-message-key={item.key}
      data-find-active={item.key === activeFindKey ? "true" : undefined}
      className={[
        "group/msg space-y-1 rounded-lg",
        item.key === activeFindKey ? "ring-2 ring-kin-blue/45" : "",
        selectionMode && selected ? "ring-1 ring-kin-blue/40 bg-kin-blue/15 p-2 -m-2" : "",
      ].join(" ")}
      {...((canRetryFork || canSave || canCopy) && !selectionMode
        ? {
            // Touch has no hover, so the actions rest hidden and a tap on the
            // body reveals them (one message at a time). A tap on a control
            // or a link inside the body does that control's job instead, and
            // a tap that ends a text selection leaves the actions alone.
            onClick: (event: ReactMouseEvent) => {
              // The tap-to-reveal is the touch answer to hover; with a
              // pointer, hover owns the row (the same `sm` cut the classes
              // use), and a click that stuck an action row on screen would
              // be a second behaviour for the same gesture.
              if (!window.matchMedia("(max-width: 639px)").matches) return;
              if (!isMessageActionsToggleTap(event.target)) return;
              toggleMobileMessageActions(storeKey);
            },
          }
        : {})}
    >
      {selectionMode && (
        <MessageSelectionControl
          role="assistant"
          selected={selected}
          onToggle={onToggleSelection}
        />
      )}
      <MessageBody text={item.text} partial={item.partial} />
      {(canRetryFork || canSave || canCopy) && (
        <div
          className={[
            // `sm:` is the desktop cut: hover exists there, so the row hides
            // until the pointer is on the message. Below it the row hides
            // until the message is tapped, and a revealed row stays visible
            // — there is no hover to lose it.
            "flex items-center gap-1 transition-opacity",
            revealed
              ? "max-sm:opacity-100 sm:opacity-0 sm:group-hover/msg:opacity-100 sm:focus-within:opacity-100"
              : "max-sm:opacity-0 max-sm:pointer-events-none sm:opacity-0 sm:group-hover/msg:opacity-100 sm:focus-within:opacity-100",
          ].join(" ")}
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
}, sameMessage);

/**
 * Whether two renders of one message would draw the same thing.
 *
 * A streaming token rebuilds every item in the transcript, so the item object
 * is never the same twice even when nothing about it changed; identity cannot
 * be the test. What the component reads is compared instead: the key (find
 * bar, mobile action store), the body and its partial flag, the seq the retry
 * and fork buttons send, and the flags that add controls or rings.
 *
 * Callbacks are deliberately not compared. They are rebuilt on every parent
 * render but their behaviour does not drift with it, and comparing them would
 * defeat the memo for the 99 messages that did not change. The one callback
 * that closes over state — selection — is covered by `selectedKeys`, which is
 * a prop of the turn and changes with it. `onSaveArtifact` is the exception:
 * its presence, not its identity, decides whether the save button exists.
 *
 * A bailed-out row keeps the handler it rendered with, so a handler that has
 * to see current state reads it from a ref rather than its closure: the save
 * button names the artifact after the session title, which is why
 * TaskDetailPage keeps that title in `taskTitleRef`.
 *
 * Exported for its clause test. Every field the component reads has a row in
 * that table; a field added to the component without one is a silent stale
 * render, not a type error.
 */
export function sameMessage(a: AssistantMessageItemProps, b: AssistantMessageItemProps): boolean {
  return (
    a.item.key === b.item.key &&
    a.item.text === b.item.text &&
    a.item.partial === b.item.partial &&
    a.item.seq === b.item.seq &&
    a.messageScope === b.messageScope &&
    a.showMessageActions === b.showMessageActions &&
    a.actionsBusy === b.actionsBusy &&
    a.activeFindKey === b.activeFindKey &&
    a.selectionMode === b.selectionMode &&
    a.selected === b.selected &&
    !!a.onSaveArtifact === !!b.onSaveArtifact
  );
}

function StandaloneRow({
  item,
  slot,
}: {
  item: Extract<ChatItem, { kind: "error" | "meta" }>;
  /** The card this event asked for, when the console still holds one. */
  slot?: ReactNode;
}) {
  const tr = useT();
  if (slot) return <>{slot}</>;
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
  hostSpeaker,
  running,
  onOpenPath,
}: {
  item: ProgressItem;
  hostSpeaker: string;
  running: boolean;
  onOpenPath?: (path: string) => void;
}) {
  const tr = useT();
  const steps = item.steps;
  // Top-level steps and the calls their subagents made, in reading order.
  const rows = progressRows(steps);
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
          {/* One line, cut with an ellipsis. The summary is a list of counts
              ("list 1 × · read 1 × · edit 1 ×"); letting it wrap on a phone
              broke between a tool name and its count and made the row two
              ragged lines tall while the fold label beside it stayed put. The
              full text is the tooltip and the steps are one tap away. */}
          <span className="truncate font-medium text-kin-text" title={summary}>
            {summary}
          </span>
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
          {/* What is behind the fold and how much of it, rather than the bare
              word "expand": the button already says it is a toggle. */}
          {collapsed
            ? steps.length > 0
              ? tr("chat.progress.collapsed", { count: steps.length })
              : tr("chat.progress.expand")
            : tr("chat.progress.hide")}
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
          {rows.map(({ step, depth, index }) =>
            step.kind === "tool" ? (
              <ToolStepRow
                key={step.key}
                tool={step}
                index={index}
                depth={depth}
                open={openStep === step.key}
                onOpenPath={onOpenPath}
                onToggle={() => setOpenStep((cur) => (cur === step.key ? null : step.key))}
              />
            ) : (
              <NoteStepRow key={step.key} note={step} index={index} hostSpeaker={hostSpeaker} />
            ),
          )}
        </div>
      )}
    </div>
  );
}

function NoteStepRow({
  note,
  index,
  hostSpeaker,
}: {
  note: NoteStep;
  index: number;
  /** The session's host agent: a note that is not its voice says whose it is. */
  hostSpeaker: string;
}) {
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
  // Where it came from, not what it reads like: thinking and narration are the
  // same shape of text, and only the event that carried them says which is which.
  const label = tr(noteLabelKey(note.source));
  const attribution = noteNeedsAttribution(note, hostSpeaker)
    ? [agentAvatarMeta(note.speaker).label, note.model].filter(Boolean).join(" · ")
    : "";
  return (
    <div className="flex items-start gap-2 px-3 py-1.5 text-body">
      <span
        aria-hidden="true"
        className="flex-none w-5 text-caption tabular-nums text-kin-muted pt-0.5"
      >
        {index}
      </span>
      <span className="sr-only">{tr("chat.progress.step", { n: index })}</span>
      <span className={`mt-1.5 w-1.5 h-1.5 rounded-full flex-none ${statusDot}`} />
      <span className="font-mono text-caption text-kin-muted flex-none pt-px">{label}</span>
      {attribution && (
        // No width of its own: the row's text keeps `flex-1`, so a long
        // attribution truncates itself rather than squeezing the note.
        <span className="min-w-0 truncate text-caption text-kin-muted pt-px" title={attribution}>
          {attribution}
        </span>
      )}
      <span className="flex-1 min-w-0 whitespace-pre-wrap break-words text-kin-secondary">
        {note.text}
      </span>
    </div>
  );
}

/** Message body only (avatar / name owned by AgentTurn for assistants). */
const MessageBody = memo(function MessageBody({
  text,
  partial,
}: {
  text: string;
  partial?: boolean;
}) {
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
});

/** A short, single-line excerpt for an accessible name: long enough to tell two
 *  queued messages apart, short enough that a screen reader is not read a
 *  pasted stack trace. Both controls on the badge name the message this way. */
function messageExcerpt(text: string): string {
  const runes = Array.from(text.replace(/\s+/g, " ").trim());
  return runes.length > 24 ? `${runes.slice(0, 24).join("")}…` : runes.join("");
}

export type MessageRowProps = {
  /** The transcript item this bubble renders; the find bar scrolls to it. */
  messageKey?: string;
  /** Set when the find bar is pointing at this message. */
  activeFindKey?: string | null;
  speaker: string;
  text: string;
  partial?: boolean;
  /** Still waiting for a turn: the daemon has it queued, not answered. */
  queued?: boolean;
  /**
   * Take this message back out of the queue. Only offered while it is still
   * waiting, and only where the console can send to this task at all.
   */
  onUnqueue?: () => void;
  /**
   * Take this message back and put its text in the composer. Offered under the
   * same conditions as `onUnqueue`.
   */
  onEditQueued?: () => void;
  selectionMode?: boolean;
  selected?: boolean;
  onToggleSelection?: () => void;
};

const MessageRow = memo(function MessageRow({
  messageKey,
  activeFindKey,
  speaker,
  text,
  partial,
  queued = false,
  onUnqueue,
  onEditQueued,
  selectionMode = false,
  selected = false,
  onToggleSelection,
}: MessageRowProps) {
  const tr = useT();
  const isUser = speaker === "user";
  const meta = agentAvatarMeta(speaker);
  // Every queued message carries the same ×. Without the message in the name, a
  // screen reader's button list is N identical "Withdraw message" entries and
  // the reader cannot tell which one is which.
  const excerpt = queued ? messageExcerpt(text) : "";
  const withdrawName = excerpt ? tr("chat.withdrawNamed", { text: excerpt }) : tr("chat.withdraw");
  const editName = excerpt ? tr("chat.editQueuedNamed", { text: excerpt }) : tr("chat.editQueued");

  if (isUser) {
    return (
      <div
        data-message-key={messageKey}
        data-find-active={messageKey && messageKey === activeFindKey ? "true" : undefined}
        className={[
          // min-w-0: let this row shrink inside the chat column so max-w on
          // the bubble can actually constrain long unbroken paths/URLs.
          "flex min-w-0 w-full justify-end gap-2.5 items-start rounded-lg",
          messageKey && messageKey === activeFindKey ? "ring-2 ring-kin-blue/45" : "",
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
                {onEditQueued && (
                  // Beside the ×, because it is the gentler half of the same
                  // thought: take the message back, but keep what it says. Same
                  // `touch-mini` treatment as the × it sits next to.
                  <button
                    type="button"
                    onClick={onEditQueued}
                    data-touch-mini
                    title={tr("chat.editQueued")}
                    aria-label={editName}
                    className="touch-mini -my-1 ml-0.5 flex h-5 w-5 flex-none items-center justify-center rounded-full text-kin-blue-ink/80 transition-colors hover:bg-kin-blue/15 hover:text-kin-blue-ink focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-kin-focus-ring"
                  >
                    <svg width="10" height="10" viewBox="0 0 10 10" aria-hidden="true">
                      <path
                        d="M1 9l.6-2.2 5.4-5.4 1.6 1.6-5.4 5.4L1 9z"
                        stroke="currentColor"
                        strokeWidth="1.1"
                        strokeLinejoin="round"
                        fill="none"
                      />
                    </svg>
                  </button>
                )}
                {onUnqueue && (
                  // Inside the badge, because that is the state it undoes: the
                  // message is in the transcript and the badge is the only thing
                  // that says it has not been sent yet.
                  //
                  // `data-touch-mini` + `touch-mini`: a bare button under
                  // `.touch-lg` is floored to 44px on a phone, which would turn
                  // a 16px pill into a 44px slab. The sanctioned opt-out is the
                  // one the composer's tile × uses — 22px on a coarse pointer.
                  <button
                    type="button"
                    onClick={onUnqueue}
                    data-touch-mini
                    title={tr("chat.withdraw")}
                    aria-label={withdrawName}
                    className="touch-mini -my-1 -mr-1 ml-0.5 flex h-5 w-5 flex-none items-center justify-center rounded-full text-kin-blue-ink/80 transition-colors hover:bg-kin-blue/15 hover:text-kin-blue-ink focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-kin-focus-ring"
                  >
                    <svg width="10" height="10" viewBox="0 0 10 10" aria-hidden="true">
                      <path
                        d="M1 1l8 8M9 1l-8 8"
                        stroke="currentColor"
                        strokeWidth="1.6"
                        strokeLinecap="round"
                      />
                    </svg>
                  </button>
                )}
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
    <div
      data-message-key={messageKey}
      data-find-active={messageKey && messageKey === activeFindKey ? "true" : undefined}
      className={[
        "flex gap-2.5 items-start rounded-lg",
        messageKey && messageKey === activeFindKey ? "ring-2 ring-kin-blue/45" : "",
      ].join(" ")}
    >
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
}, sameRow);

/** Same reasoning as `sameMessage`: compare what is drawn, not the closures. */
export function sameRow(a: MessageRowProps, b: MessageRowProps): boolean {
  return (
    a.messageKey === b.messageKey &&
    a.activeFindKey === b.activeFindKey &&
    a.speaker === b.speaker &&
    a.text === b.text &&
    a.partial === b.partial &&
    a.queued === b.queued &&
    // Presence, not identity: the control is there or it is not, and the fresh
    // closure a redraw would bring is not worth one. Same rule `sameMessage`
    // uses for the save button.
    !!a.onUnqueue === !!b.onUnqueue &&
    !!a.onEditQueued === !!b.onEditQueued &&
    a.selectionMode === b.selectionMode &&
    a.selected === b.selected
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
