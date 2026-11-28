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
  useId,
  useLayoutEffect,
  useMemo,
  useRef,
  useState,
  type MouseEvent as ReactMouseEvent,
  type ReactNode,
} from "react";
import type { TaskEvent } from "../../api/client";
import { formatDuration } from "../../lib/duration";
import { findMatches, stepMatch } from "../../lib/findInTranscript";
import { friendlyErrorLabel } from "../../lib/friendlyError";
import { useLocale, useT } from "../../i18n/react";
import { isImeKeyEvent } from "../../lib/ime";
import { isMessageQueued } from "../../lib/queuedPrompts";
import { overlayOwnsKeyboard } from "../../lib/overlayOwnsKeyboard";
import { agentAvatarMeta } from "../../lib/agentMention";
import {
  isMessageActionsToggleTap,
  toggleMobileMessageActions,
  useMobileMessageActionsRevealed,
} from "../../lib/mobileMessageActions";
import { useCoarsePointer } from "../../hooks/useMediaQuery";
import { useAppStore } from "../../store/appStore";
import { IconChevron, IconCopy, IconDownload, IconSearch, IconShare, IconX } from "../icons";
import Button from "../ui/Button";
import Markdown from "../Markdown";
import RoundEvidenceCard from "./RoundEvidenceCard";
import ToolStepRow from "./ToolStepRow";
import { formatSharedHTML, formatSharedText, type SharedMessage } from "./shareExport";
import UserAttachments from "./UserAttachments";
import type { UserImage } from "../../lib/attachments";
import {
  buildChatItems,
  findSpeakerModel,
  groupIntoTurns,
  isProgressCardRunning,
  mergeProcessRuns,
  noteLabelKey,
  noteNeedsAttribution,
  normalizeModel,
  prettyToolName,
  progressRows,
  roundEvidenceByTurn,
  shouldShowGenericThinking,
  summarizeProgressDetails,
  summarizeProgressStatus,
  type ChatItem,
  type CompactionItem,
  type NoteStep,
  type ProgressItem,
  type Turn,
} from "./transcriptProjection";

/** One empty set, shared: the default for a stream that has no queue to show. */
const EMPTY_QUEUED: Set<number> = new Set();

/** One empty result, shared: a closed find bar has nothing to point at. */
const NO_FIND_HITS: readonly string[] = [];

/** One local copy of a send the daemon has not echoed yet. */
export type PendingUserMessage = { key: string; text: string; images?: UserImage[] };

type Props = {
  events: TaskEvent[];
  /** Fallback first user bubble when create hasn't seeded events yet. */
  fallbackUserPrompt?: string;
  /** Pictures that fallback prompt carried; the text alone no longer names them. */
  fallbackUserPromptImages?: UserImage[];
  /**
   * User messages the composer has already handed over but the transcript does
   * not contain yet. They are drawn as ordinary user bubbles at the end of the
   * stream, so the waiting row below them has something to wait under instead
   * of the send disappearing until the daemon answers. The sender removes one
   * when its server copy lands; this component never edits the list itself.
   */
  pendingUserMessages?: readonly PendingUserMessage[];
  /** Approvals / cards rendered after messages. */
  trailing?: ReactNode;
  /**
   * Show a thinking/loading row while the task is live but nothing is
   * streaming yet (and no progress is mid-run).
   */
  loading?: boolean;
  /**
   * The task's durable status. A Stop the adapter never recorded leaves the
   * events with an open round; the terminal `canceled` status is what lets the
   * projection close it in the transcript.
   */
  taskStatus?: string | null;
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
   * Where each still-waiting message sits in the daemon's delivery order, keyed
   * by the seq of the message it belongs to, one for the first. The page builds
   * this from the queue as received; the row only draws it, because re-deriving
   * the order here would show an arrangement the agent will not follow.
   */
  queuePositions?: ReadonlyMap<number, number>;
  /** How many prompts are queued, so a lone one shows no place in line. */
  queueLength?: number;
  /**
   * Move a queued message one slot, given the seq of the message it belongs to
   * and the direction (`-1` earlier, `1` later). Undefined hides the arrows —
   * a transcript that is not live has no order to change.
   */
  onMoveQueued?: (seq: number, delta: -1 | 1) => void;
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
  /** Open a workspace path in the Files panel (from tool rows). */
  onOpenPath?: (path: string) => void;
  /**
   * Whether the task checkout can name a path. Absent means every path is
   * offered, exactly as before; the predicate travels down this prop thread
   * rather than being re-derived, because the pages own the task cwd.
   */
  canOpenPath?: (path: string) => boolean;
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
  /**
   * A query to open the find bar with. The chat search sends the reader here
   * with the words they searched for, so the conversation shows the match
   * rather than its first line. Seeding happens when this value changes, not on
   * every open: closing the bar must leave it closed.
   */
  findSeed?: string;
  /**
   * A host surface (the imported-session sheet) already names the host agent
   * above the transcript. When the oldest visible turn is that agent's, its
   * own speaker header would print the same avatar and name directly below
   * the host's; opt in to drop that first identity. Later turns and delegated
   * speakers keep their attribution.
   */
  hideFirstSpeaker?: boolean;
};

export default function ChatStream({
  events,
  fallbackUserPrompt,
  fallbackUserPromptImages,
  pendingUserMessages,
  trailing,
  loading = false,
  taskStatus,
  loadingSpeaker = "",
  hostSpeaker = "",
  hostModel,
  queuedSeqs,
  onUnqueue,
  onEditQueued,
  queuePositions,
  queueLength,
  onMoveQueued,
  messageScope = "",
  pendingSlots,
  showMessageActions = false,
  actionsBusy = false,
  onRetry,
  onFork,
  onOpenPath,
  canOpenPath,
  findOpen: findOpenProp,
  onFindOpenChange,
  findShortcut = true,
  findSeed,
  hideFirstSpeaker = false,
}: Props) {
  const { locale } = useLocale();
  const tr = useT();
  const pushToast = useAppStore((s) => s.pushToast);
  const [sharing, setSharing] = useState(false);
  const [selectedKeys, setSelectedKeys] = useState<Set<string>>(() => new Set());
  // Rebuild when locale changes (tool summaries use t()).
  const items = useMemo(() => {
    // While the turn runs, the projection keeps its notes as body text and its
    // tools in a card; a settled turn folds into one row as it always has.
    const built = mergeProcessRuns(
      buildChatItems(events, hostSpeaker, hostModel, !loading, taskStatus),
      loading,
    );
    if (!pendingUserMessages || pendingUserMessages.length === 0) return built;
    // Appended after the projection rather than passed into it: these messages
    // have no event, so they start no round and carry no seq. What they do have
    // is a place — after everything the transcript knows — which is exactly
    // where the waiting row looks for the turn it belongs to.
    return [
      ...built,
      ...pendingUserMessages.map((message): ChatItem => ({
        kind: "message",
        key: message.key,
        speaker: "user",
        text: message.text,
        images: message.images,
        partial: false,
      })),
    ];
  }, [events, locale, hostSpeaker, hostModel, loading, taskStatus, pendingUserMessages]);
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

  // A search result opens the bar on its own words. Keyed on the seed rather
  // than on `findOpen`, or closing the bar would fill it again on the next
  // render; the page holds the seed steady for as long as its URL does.
  useEffect(() => {
    if (!findSeed) return;
    setFindQuery(findSeed);
    setFindIndex(0);
    setFindOpen(true);
  }, [findSeed, setFindOpen]);

  // Nothing to count while the bar is shut, and a closed bar must leave no ring
  // behind: the hits, and with them the active key, exist only while it is open.
  const findHits = useMemo(() => {
    if (!findOpen) return NO_FIND_HITS;
    // The transcript carries readable text in two places: message bubbles and
    // the note rows inside a process card. A message that the projection folded
    // into a card keeps its key, so a hit can be landed on wherever it is
    // drawn. Tool steps and error rows are labels and outputs, not prose.
    // Partial messages stream, so they are matched as they stand rather than
    // being frozen out until they finish.
    const findable: { key: string; text: string }[] = [];
    for (const item of items) {
      if (item.kind === "message") {
        if (item.text.trim().length > 0) findable.push({ key: item.key, text: item.text });
        continue;
      }
      if (item.kind !== "progress") continue;
      for (const step of item.steps) {
        if (step.kind === "note" && step.text.trim().length > 0) {
          findable.push({ key: step.key, text: step.text });
        }
      }
    }
    return findMatches(findable, findQuery);
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
      if (isImeKeyEvent(event)) return;
      // A handler closer to the key already claimed it — the editor's own
      // find, an open dialog's shortcut. A window listener runs last, and
      // reopening this bar over whatever just handled the key is the wrong
      // layer; the Escape branch below checks the flag after dispatch for the
      // opposite reason (the palette registers later than this listener).
      if (event.defaultPrevented) return;
      // A menu, a sheet or a dialog over this conversation owns the keyboard.
      // Opening the bar would move focus into a field the reader cannot see,
      // and the next keystrokes would go there instead of the overlay.
      if (overlayOwnsKeyboard()) return;
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
            images={turn.item.images}
            partial={turn.item.partial}
            queued={queued}
            // Whether the control may show at all is the row's call: it is the
            // one place that knows the message is still waiting.
            onUnqueue={onUnqueue && seq !== undefined ? () => onUnqueue(seq) : undefined}
            onEditQueued={onEditQueued && seq !== undefined ? () => onEditQueued(seq) : undefined}
            queuePlace={queued && seq !== undefined ? queuePositions?.get(seq) : undefined}
            queueLength={queueLength}
            onMoveQueued={
              onUnqueue && onMoveQueued && seq !== undefined
                ? (delta) => onMoveQueued(seq, delta)
                : undefined
            }
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
            hideIdentity={hideFirstSpeaker && turnIdx === 0 && turn.speaker === hostSpeaker}
            pendingSlots={pendingSlots}
            loading={loading}
            allItems={items}
            showThinking={withThinking}
            messageScope={messageScope}
            showMessageActions={showMessageActions}
            actionsBusy={actionsBusy}
            onRetry={onRetry}
            onFork={onFork}
            onOpenPath={onOpenPath}
            canOpenPath={canOpenPath}
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
      data-conversation-pane
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
                if (isImeKeyEvent(event.nativeEvent)) return;
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
          {/* Icon affordances on the console's facade. The quiet variant inks
              its own label, so the muted-at-rest ink sits on the content and
              follows the button's hover; the round hit area the facade draws the
              focus ring around stays the same 32px box, floored to 44 on a
              phone by the same rule that floored the bare button. */}
          <Button
            variant="quiet"
            onClick={() => stepFind(-1)}
            disabled={findHits.length === 0}
            aria-label={tr("chat.find.prev")}
            title={tr("chat.find.prev")}
            className="h-8 w-8 flex-none rounded-full p-0"
          >
            <span className="flex h-8 w-8 items-center justify-center text-kin-muted transition-colors hover:text-kin-text">
              <IconChevron size={15} className="-rotate-90" />
            </span>
          </Button>
          <Button
            variant="quiet"
            onClick={() => stepFind(1)}
            disabled={findHits.length === 0}
            aria-label={tr("chat.find.next")}
            title={tr("chat.find.next")}
            className="h-8 w-8 flex-none rounded-full p-0"
          >
            <span className="flex h-8 w-8 items-center justify-center text-kin-muted transition-colors hover:text-kin-text">
              <IconChevron size={15} className="rotate-90" />
            </span>
          </Button>
          <Button
            variant="quiet"
            onClick={() => setFindOpen(false)}
            aria-label={tr("chat.find.close")}
            title={tr("chat.find.close")}
            className="h-8 w-8 flex-none rounded-full p-0"
          >
            <span className="flex h-8 w-8 items-center justify-center text-kin-muted transition-colors hover:text-kin-text">
              <IconX size={15} />
            </span>
          </Button>
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
        <MessageRow
          speaker="user"
          text={fallbackUserPrompt}
          images={fallbackUserPromptImages}
          partial={false}
        />
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
            <RoundEvidenceCard
              evidence={evidence}
              onOpenPath={onOpenPath}
              canOpenPath={canOpenPath}
            />
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
  hideIdentity = false,
  pendingSlots,
  loading,
  allItems,
  showThinking,
  messageScope = "",
  showMessageActions = false,
  actionsBusy = false,
  onRetry,
  onFork,
  onOpenPath,
  canOpenPath,
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
  /** See ChatStream's `hideFirstSpeaker`: drop this turn's avatar and name. */
  hideIdentity?: boolean;
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
  onOpenPath?: (path: string) => void;
  /** See ChatStream's `canOpenPath`: whether the task checkout can name a path. */
  canOpenPath?: (path: string) => boolean;
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
      {hideIdentity ? (
        // The host above already carried the avatar; keep its column so the
        // message text stays on the same left edge as every later turn.
        <div className="w-[28px] flex-none" aria-hidden="true" />
      ) : (
        <div
          className={`w-[28px] h-[28px] flex-none rounded-lg flex items-center justify-center text-caption font-bold ${meta.className}`}
          title={agentIdentityTitle(meta.label, model)}
        >
          {meta.initials}
        </div>
      )}
      <div className="flex-1 min-w-0 flex flex-col gap-2.5 pt-0.5">
        {hideIdentity ? null : (
          <div className="flex items-start gap-2">
            <AgentIdentity name={meta.label} model={model} />
            {hasPartial && (
              <span className="mt-px inline-flex items-center gap-1.5 text-caption text-kin-muted">
                <span className="w-1.5 h-1.5 rounded-full bg-kin-blue animate-breathe" />
                {tr("chat.streaming")}
              </span>
            )}
          </div>
        )}

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
                  activeFindKey={activeFindKey}
                  selectionMode={selectionMode}
                  selected={selectedKeys.has(item.key)}
                  onToggleSelection={() => onToggleSelection(item.key)}
                  onCopyMessage={onCopyMessage}
                  onShareMessage={onShareMessage}
                />
              );
            case "progress": {
              // A live turn's notes are body text: the reader is following what
              // the agent thinks and says, not reading a summary of work already
              // done. The tools keep their card. Only the run still in progress
              // is split, and only its notes carry `prose`; an earlier round's
              // notes stay folded in that round's card. A subagent's note is a
              // top-level step, not a child of the tool row that spawned it, so
              // it arrives here too — rendered as body prose with attribution.
              // Nothing here can pull a nested row out: only ToolSteps nest.
              // Settled turns keep their card even when it held only notes: the
              // split is the running presentation, not a new settled shape.
              if (
                item.prose === true &&
                item.steps.length > 0 &&
                item.steps.every((step) => step.kind === "note")
              ) {
                return (
                  <Fragment key={item.key}>
                    {item.steps.map((step) => (
                      <NoteStepRow
                        key={step.key}
                        note={step}
                        index={1}
                        hostSpeaker={hostSpeaker}
                        findActive={step.key === activeFindKey}
                        showIndex={false}
                      />
                    ))}
                  </Fragment>
                );
              }
              return (
                <ProgressCard
                  key={item.key}
                  item={item}
                  hostSpeaker={hostSpeaker}
                  // Only the live run's card can be followed by notes; an
                  // earlier round's unresolved call must not breathe through
                  // the rest of the task.
                  running={
                    isProgressCardRunning(allItems, item, loading) ||
                    (item.live === true &&
                      item.steps.some((step) => step.kind === "tool" && step.status === "running"))
                  }
                  onOpenPath={onOpenPath}
                  canOpenPath={canOpenPath}
                  activeFindKey={activeFindKey}
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
            case "compaction":
              return <CompactionRow key={item.key} item={item} />;
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

        {/* One wait cue: the dots. The words are the cue's accessible name, not a
            second visible line saying the same thing. */}
        {showThinking && !hasPartial && <ThinkingDots label={tr("chat.thinking")} />}
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
  activeFindKey,
  selectionMode,
  selected,
  onToggleSelection,
  onCopyMessage,
  onShareMessage,
}: AssistantMessageItemProps) {
  const tr = useT();
  const canRetryFork = showMessageActions && !item.partial && typeof item.seq === "number";
  const canCopy = !item.partial && item.text.trim().length > 0;
  // The store is module-level, so the key must name the task as well as the
  // message: several sessions stay mounted (tab host), and their seqs collide.
  const storeKey = messageScope ? `${messageScope}:${item.key}` : item.key;
  const revealed = useMobileMessageActionsRevealed(storeKey);
  // A finger has no hover at any width. The old reveal was scoped to the phone
  // breakpoint, so an iPad at 768/820 drew the desktop layout with the row at
  // `opacity: 0` and no `pointer-events` rule: invisible, still hit-testable,
  // and a tap meant to read the answer could press 重试. With a coarse pointer
  // the hidden row is inert everywhere, and the tap that reveals it is the only
  // way in; a mouse keeps today's hover/focus reveal (TASTE 21).
  const coarsePointer = useCoarsePointer();
  const actionsInert = coarsePointer && !revealed;
  return (
    <div
      data-message-key={item.key}
      data-find-active={item.key === activeFindKey ? "true" : undefined}
      className={[
        "group/msg space-y-1 rounded-lg",
        item.key === activeFindKey ? "ring-2 ring-kin-blue/45" : "",
        selectionMode && selected ? "ring-1 ring-kin-blue/40 bg-kin-blue/15 p-2 -m-2" : "",
      ].join(" ")}
      {...((canRetryFork || canCopy) && !selectionMode
        ? {
            // Touch has no hover, so the actions rest hidden and a tap on the
            // body reveals them (one message at a time). A tap on a control
            // or a link inside the body does that control's job instead, and
            // a tap that ends a text selection leaves the actions alone. The
            // coarse arm is the iPad: same gesture, at a width where the
            // desktop layout draws the row.
            onClick: (event: ReactMouseEvent) => {
              // The tap-to-reveal is the touch answer to hover; with a fine
              // pointer, hover owns the row (the same `sm` cut the classes
              // use), and a click that stuck an action row on screen would
              // be a second behaviour for the same gesture.
              if (!coarsePointer && !window.matchMedia("(max-width: 639px)").matches) return;
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
      {(canRetryFork || canCopy) && (
        <div
          className={[
            // `sm:` is the desktop cut: hover exists there, so the row hides
            // until the pointer is on the message. Below it the row hides
            // until the message is tapped, and a revealed row stays visible
            // — there is no hover to lose it. A coarse pointer skips the
            // `sm:` cut entirely: an iPad has no hover to reveal the row, and
            // an opacity-0 row that still takes pointer events is a tap target
            // nobody can see. Focus stays a reveal so Tab reaches the buttons.
            // A coarse pointer also floors each action's own width at 44px
            // (`min-w-11`): the desktop density draws 重试/分叉 at 40.5px, and
            // the global touch floor now reaches the iPad band (coarse, up to
            // 1023.98px), where it floors this width too. Past 1023.98px
            // (iPad landscape) the floor does not reach, so the explicit
            // `min-w-11` is what keeps the width at 44px there.
            "flex items-center gap-1 transition-opacity",
            coarsePointer
              ? revealed
                ? "opacity-100"
                : "opacity-0 pointer-events-none focus-within:opacity-100 focus-within:pointer-events-auto"
              : revealed
                ? "max-sm:opacity-100 sm:opacity-0 sm:group-hover/msg:opacity-100 sm:focus-within:opacity-100"
                : "max-sm:opacity-0 max-sm:pointer-events-none sm:opacity-0 sm:group-hover/msg:opacity-100 sm:focus-within:opacity-100",
          ].join(" ")}
          data-message-actions=""
          data-actions-state={revealed ? "revealed" : "hidden"}
          data-actions-inert={actionsInert ? "true" : undefined}
          role="group"
          aria-label={tr("task.actions")}
        >
          {canRetryFork && (
            <>
              {/* The row's affordances are muted until hovered; the quiet
                  variant inks its own label, so the ink sits on the content and
                  follows the button's hover through the group mark. */}
              <Button
                variant="quiet"
                disabled={actionsBusy}
                title={tr("task.retryTitle")}
                onClick={() => onRetry?.(item.seq!)}
                className={`group rounded-md px-2 py-0.5 text-caption font-medium ${coarsePointer ? "min-w-11" : ""}`}
              >
                <span className="text-kin-muted transition-colors group-hover:text-kin-text">
                  {tr("task.retry")}
                </span>
              </Button>
              <Button
                variant="quiet"
                disabled={actionsBusy}
                title={tr("task.forkTitle")}
                onClick={() => onFork?.(item.seq!)}
                className={`group rounded-md px-2 py-0.5 text-caption font-medium ${coarsePointer ? "min-w-11" : ""}`}
              >
                <span className="text-kin-muted transition-colors group-hover:text-kin-text">
                  {tr("task.fork")}
                </span>
              </Button>
            </>
          )}
          {canCopy && (
            <>
              <Button
                variant="quiet"
                title={tr("chat.message.copyTitle")}
                aria-label={tr("chat.message.copyTitle")}
                onClick={() => onCopyMessage(item.text)}
                className={`group rounded-md px-2 py-0.5 text-caption font-medium ${coarsePointer ? "min-w-11" : ""}`}
              >
                <span className="inline-flex items-center gap-1 text-kin-muted transition-colors group-hover:text-kin-text">
                  <IconCopy size={13} />
                  {tr("chat.message.copy")}
                </span>
              </Button>
              <Button
                variant="quiet"
                title={tr("chat.message.shareTitle")}
                aria-label={tr("chat.message.shareTitle")}
                onClick={() => onShareMessage(item.key)}
                className={`group rounded-md px-2 py-0.5 text-caption font-medium ${coarsePointer ? "min-w-11" : ""}`}
              >
                <span className="inline-flex items-center gap-1 text-kin-muted transition-colors group-hover:text-kin-text">
                  <IconShare size={13} />
                  {tr("chat.message.share")}
                </span>
              </Button>
            </>
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
 * a prop of the turn and changes with it.
 *
 * A bailed-out row keeps the handler it rendered with, so a handler that has
 * to see current state reads it from a ref rather than its closure.
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
    a.selected === b.selected
  );
}

function StandaloneRow({
  item,
  slot,
}: {
  item: Extract<ChatItem, { kind: "error" | "meta" | "compaction" }>;
  /** The card this event asked for, when the console still holds one. */
  slot?: ReactNode;
}) {
  const tr = useT();
  if (slot) return <>{slot}</>;
  if (item.kind === "compaction") return <CompactionRow item={item} />;
  if (item.kind === "error") {
    return (
      <div className="rounded-xl border border-kin-red/30 bg-kin-red/10 px-3.5 py-2.5 text-strong text-kin-red-ink">
        {friendlyErrorLabel(item.message, tr)}
      </div>
    );
  }
  return <p className="text-center text-caption text-kin-muted">{item.label}</p>;
}

/**
 * One context compaction: a quiet line, and the whole summary behind it.
 *
 * Follows ProgressCard's disclosure without being a card — one line for one
 * compaction. It is not a message: no avatar, no actions, no selection. While
 * the summary streams, the line says so and draws none of the half-written
 * text, so a paragraph the agent wrote about its own memory is never mistaken
 * for something it said to the reader.
 */
function CompactionRow({ item }: { item: CompactionItem }) {
  const tr = useT();
  const [expanded, setExpanded] = useState(false);
  const summaryId = useId();
  if (item.partial) {
    return (
      // The line is the status: it carries the announcement the generic
      // thinking row would otherwise make, so one moment gets one cue.
      <p
        data-compaction-hint
        aria-live="polite"
        className="flex items-center gap-1.5 text-caption text-kin-muted"
      >
        <span
          className="w-1.5 h-1.5 flex-none rounded-full bg-kin-blue animate-breathe"
          aria-hidden="true"
        />
        {tr("chat.compaction.running")}
      </p>
    );
  }
  // A compaction the adapter could only report as a notice has no summary to
  // open. A disclosure that expands to an empty box is a dead control; the
  // line still says what happened.
  if (!item.text.trim()) {
    return (
      <p data-compaction-hint className="text-caption text-kin-muted">
        {tr("chat.compaction.label")}
      </p>
    );
  }
  return (
    <div data-compaction-hint>
      <Button
        variant="quiet"
        onClick={() => setExpanded((value) => !value)}
        aria-expanded={expanded}
        aria-controls={expanded ? summaryId : undefined}
        className="flex w-full justify-start rounded-md p-0 text-left text-caption font-normal cursor-pointer hover:bg-transparent"
      >
        <span className="flex w-full min-w-0 items-center gap-2 rounded-md px-2 py-1.5 text-kin-muted transition-colors hover:bg-[var(--kin-fill)]">
          <span className="min-w-0 flex-1 truncate">
            {tr(expanded ? "chat.compaction.hide" : "chat.compaction.show")}
          </span>
        </span>
      </Button>
      {expanded && (
        // Complete, not shortened: the summary scrolls inside its own bound
        // rather than being cut off, and keeps its line breaks as written. The
        // region is focusable so a keyboard user can scroll the part past the
        // fold, which has no other focusable descendant.
        <div
          id={summaryId}
          role="region"
          aria-label={tr("chat.compaction.label")}
          tabIndex={0}
          className="mt-0.5 ml-3 max-h-64 overflow-y-auto border-t border-[var(--kin-hairline)] px-2 py-2 focus-visible:outline focus-visible:outline-2 focus-visible:outline-offset-2 focus-visible:outline-kin-focus-ring"
        >
          <p className="whitespace-pre-wrap break-words text-body leading-prose text-kin-text">
            {item.text}
          </p>
        </div>
      )}
    </div>
  );
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
        </div>
        {/* The wrapper carries the sentence for a screen reader; the dots are
            the one visible cue. */}
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

function ThinkingDots({ label }: { label?: string }) {
  return (
    <div
      className="inline-flex items-center gap-1.5 h-7 px-3 rounded-2xl border border-[var(--kin-hairline)] bg-[var(--kin-fill)] w-fit"
      role="status"
      aria-live="polite"
      aria-label={label}
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
  canOpenPath,
  activeFindKey,
}: {
  item: ProgressItem;
  hostSpeaker: string;
  running: boolean;
  onOpenPath?: (path: string) => void;
  /** See ChatStream's `canOpenPath`: whether the task checkout can name a path. */
  canOpenPath?: (path: string) => boolean;
  /** The find hit the bar is pointing at, if any. */
  activeFindKey?: string | null;
}) {
  const tr = useT();
  const steps = item.steps;
  // Top-level steps and the calls their subagents made, in reading order.
  const rows = progressRows(steps);
  const [collapsed, setCollapsed] = useState(true);
  const [dismissedReveal, setDismissedReveal] = useState<string | null>(null);
  // A dismissal belongs to the hit it was made on. Landing on another note, or
  // running the same search again after closing the bar, has to open the card:
  // the row the bar points at is otherwise not in the DOM.
  useEffect(() => {
    setDismissedReveal(null);
  }, [activeFindKey]);
  // A find hit inside a folded card has to be visible: the bar points at a row
  // that would not otherwise be in the DOM, and scrolling cannot reach what was
  // never drawn. The reader can still fold it back for this one hit.
  const revealKey =
    activeFindKey && steps.some((step) => step.kind === "note" && step.key === activeFindKey)
      ? activeFindKey
      : null;
  const revealed = revealKey !== null && dismissedReveal !== revealKey;
  const expanded = revealed || !collapsed;
  const [openStep, setOpenStep] = useState<string | null>(null);
  const details = summarizeProgressDetails(steps);
  const status = summarizeProgressStatus(steps, running);
  const hasFailure = status.state === "failed" || status.state === "partial_failed";

  // What is being called right now, not every call the run ever made: the
  // present tense has to stay true while the reader is looking at it.
  const calling = rows
    .flatMap((row) =>
      row.step.kind === "tool" && row.step.status === "running"
        ? [prettyToolName(row.step.name)]
        : [],
    )
    .join(" · ");

  const notesSentence = tr("chat.progress.notes", { count: details.noteCount });

  // The failures the state was derived from: tools on a card that holds any,
  // the notes themselves on a card that holds only notes.
  const failed = status.failedTools + status.failedNotes;

  // One sentence for the whole run. Composition rules, in order: a live run
  // names the call still in flight, and only that — the moment every call has
  // returned it says what it called, because "Calling" over a settled call is
  // a lie; a failed run says how many failed (never silently); a settled run
  // says what it called. A card that only ever held notes says how many,
  // because there is no call to name.
  const summary = (() => {
    if (status.state === "running" && calling) {
      return tr("chat.progress.summaryRunning", { activity: calling });
    }
    if (status.state === "failed") {
      // A note-only run fails through its notes; the count follows the same
      // steps the state came from, so this is never "0 failed".
      return tr("chat.progress.summaryFailed", { failed });
    }
    if (status.state === "partial_failed") {
      return tr("chat.progress.summaryMixed", {
        failed,
        activity: details.toolCounts || notesSentence,
      });
    }
    return details.toolCounts
      ? tr("chat.progress.summaryDone", { activity: details.toolCounts })
      : notesSentence;
  })();

  // Nothing behind the fold: there is no line to draw.
  if (rows.length === 0) return null;

  return (
    <div>
      {/* The run's whole face is one line. The state chip and the "N steps
          collapsed" label each repeated what the sentence already said; the dot
          is the only status mark left, and only while it means something (a
          call is running, or something failed). The line is still a full-width
          disclosure on the console's facade. */}
      <Button
        variant="quiet"
        onClick={() => {
          // Folding a card that a hit forced open dismisses the reveal for that
          // hit; the next hit opens it again.
          if (revealed) setDismissedReveal(revealKey);
          else setCollapsed((v) => !v);
        }}
        aria-expanded={expanded}
        className="flex w-full justify-start rounded-md p-0 text-left text-caption font-normal cursor-pointer hover:bg-transparent"
      >
        <span className="flex w-full min-w-0 items-center gap-2 rounded-md px-2 py-1.5 text-kin-muted transition-colors hover:bg-[var(--kin-fill)]">
          {status.state === "running" && (
            <span
              className="w-1.5 h-1.5 flex-none rounded-full bg-kin-blue animate-breathe"
              aria-hidden="true"
            />
          )}
          {hasFailure && (
            <span
              data-progress-state={status.state}
              className="w-1.5 h-1.5 flex-none rounded-full bg-kin-red"
              aria-hidden="true"
            />
          )}
          <span
            className={["min-w-0 flex-1 truncate", hasFailure ? "text-kin-red-ink" : ""].join(" ")}
            title={summary}
          >
            {summary}
          </span>
          {!running && item.durationMs != null && (
            // The settled face of the run: one number that does not change once
            // the turn is done. A live card never gets one — a clock that does
            // not tick would be a lie.
            <span
              className="flex-none tabular-nums text-kin-muted"
              data-progress-duration={item.durationMs}
            >
              · {formatDuration(item.durationMs)}
            </span>
          )}
          {expanded && <span className="flex-none text-kin-muted">{tr("chat.progress.hide")}</span>}
        </span>
      </Button>
      {expanded && (
        // The steps are indented under the sentence rather than boxed in it:
        // the line reads as prose, and the rule says where the detail starts.
        // `divide-y` separates the rows from each other.
        <div className="mt-0.5 ml-3 border-t border-[var(--kin-hairline)] divide-y divide-[var(--kin-hairline)]">
          {rows.map(({ step, depth, index }) =>
            step.kind === "tool" ? (
              <ToolStepRow
                key={step.key}
                tool={step}
                index={index}
                depth={depth}
                open={openStep === step.key}
                onOpenPath={onOpenPath}
                canOpenPath={canOpenPath}
                onToggle={() => setOpenStep((cur) => (cur === step.key ? null : step.key))}
              />
            ) : (
              <NoteStepRow
                key={step.key}
                note={step}
                index={index}
                hostSpeaker={hostSpeaker}
                findActive={step.key === activeFindKey}
              />
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
  findActive = false,
  showIndex = true,
}: {
  note: NoteStep;
  index: number;
  /** The session's host agent: a note that is not its voice says whose it is. */
  hostSpeaker: string;
  /** The note the find bar is pointing at. */
  findActive?: boolean;
  /** A step of a numbered card; body prose has no step list to number. */
  showIndex?: boolean;
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
  // Narration has no label: "note" in front of a sentence the agent plainly said
  // tells the reader nothing the sentence does not.
  const labelKey = noteLabelKey(note.source);
  const attribution = noteNeedsAttribution(note, hostSpeaker)
    ? [agentAvatarMeta(note.speaker).label, note.model].filter(Boolean).join(" · ")
    : "";
  return (
    <div
      data-message-key={note.key}
      data-find-active={findActive ? "true" : undefined}
      className={[
        "flex items-start gap-2 px-3 py-1.5 text-body",
        findActive ? "ring-2 ring-kin-blue/45" : "",
      ].join(" ")}
    >
      {showIndex && (
        <>
          <span
            aria-hidden="true"
            className="flex-none w-5 text-caption tabular-nums text-kin-muted pt-0.5"
          >
            {index}
          </span>
          <span className="sr-only">{tr("chat.progress.step", { n: index })}</span>
        </>
      )}
      <span className={`mt-1.5 w-1.5 h-1.5 rounded-full flex-none ${statusDot}`} />
      {labelKey && (
        <span className="font-mono text-caption text-kin-muted flex-none pt-px">
          {tr(labelKey)}
        </span>
      )}
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
  /** Pictures this user message carried, drawn above its body. */
  images?: UserImage[];
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
  /** This message's place in the delivery queue, one for the first. */
  queuePlace?: number;
  /** How many messages are waiting; a lone one shows no place. */
  queueLength?: number;
  /** Move this message one slot. Undefined hides the arrows. */
  onMoveQueued?: (delta: -1 | 1) => void;
  selectionMode?: boolean;
  selected?: boolean;
  onToggleSelection?: () => void;
};

const MessageRow = memo(function MessageRow({
  messageKey,
  activeFindKey,
  speaker,
  text,
  images,
  partial,
  queued = false,
  onUnqueue,
  onEditQueued,
  queuePlace,
  queueLength,
  onMoveQueued,
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
  const moveUpName = excerpt
    ? tr("chat.moveQueuedUpNamed", { text: excerpt })
    : tr("chat.moveQueuedUp");
  const moveDownName = excerpt
    ? tr("chat.moveQueuedDownNamed", { text: excerpt })
    : tr("chat.moveQueuedDown");
  // A place only means something against a queue longer than one. `queuePlace`
  // is the page's numbering of the daemon's order; this row never derives it.
  const place = queued && queuePlace !== undefined && (queueLength ?? 0) > 1 ? queuePlace : null;
  // Moving a message into the first or last place unmounts the arrow that was
  // pressed: focus drops to <body> and a keyboard user loses the controls they
  // were operating. The handler notes a press that came from the focused
  // button, and the effect follows the move to the arrow that survives — a
  // pointer that landed somewhere else keeps the focus the reader chose.
  const moveFocusedRef = useRef(false);
  const moveUpRef = useRef<HTMLButtonElement>(null);
  const moveDownRef = useRef<HTMLButtonElement>(null);
  useLayoutEffect(() => {
    if (!moveFocusedRef.current) return;
    moveFocusedRef.current = false;
    if (document.activeElement !== document.body && document.activeElement !== null) return;
    (moveUpRef.current ?? moveDownRef.current)?.focus();
  }, [place, queueLength]);

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
              // The pill is the queued message's one interactive cluster:
              // place, 上移/下移, 编辑 and 撤回. `FloatingApproval` measures
              // every `[data-kin-hit-row]` box before it draws the decision
              // card, and without this marker the card painted over these
              // arrows on a phone — a real thumb landed on the card and the
              // daemon's queue never moved (dogfood 2026-11-28 13). The marker
              // is on the pill, not the bubble: the card yields to the
              // controls, not to the message text.
              <span
                data-kin-hit-row=""
                className="inline-flex items-center gap-1 rounded-full bg-kin-blue/15 px-1.5 py-px text-caption font-medium text-kin-blue-ink"
              >
                <span className="w-1.5 h-1.5 rounded-full bg-kin-blue animate-breathe" />
                {place !== null && (
                  <span
                    data-queue-place={place}
                    className="min-w-[1ch] text-center font-semibold tabular-nums"
                  >
                    {place}
                  </span>
                )}
                {tr("chat.queued")}
                {onMoveQueued && place !== null && (
                  // The order controls sit beside the place they change. They
                  // carry the same 44px phone floor as the × and the pencil:
                  // this pill is a primary mid-run surface, and a thumb a few
                  // pixels off a 10px chevron must still land on it.
                  <>
                    {place > 1 && (
                      <button
                        ref={moveUpRef}
                        type="button"
                        onClick={(event) => {
                          if (document.activeElement === event.currentTarget) {
                            moveFocusedRef.current = true;
                          }
                          onMoveQueued(-1);
                        }}
                        title={tr("chat.moveQueuedUp")}
                        aria-label={moveUpName}
                        className="ml-0.5 flex h-5 w-5 flex-none items-center justify-center rounded-full text-kin-blue-ink/80 transition-colors hover:bg-kin-blue/15 hover:text-kin-blue-ink focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-kin-focus-ring md:-my-1"
                      >
                        <svg width="10" height="10" viewBox="0 0 10 10" aria-hidden="true">
                          <path
                            d="M6.5 1.5L3 5l3.5 3.5"
                            stroke="currentColor"
                            strokeWidth="1.4"
                            strokeLinecap="round"
                            strokeLinejoin="round"
                            fill="none"
                          />
                        </svg>
                      </button>
                    )}
                    {place < (queueLength ?? 0) && (
                      <button
                        ref={moveDownRef}
                        type="button"
                        onClick={(event) => {
                          if (document.activeElement === event.currentTarget) {
                            moveFocusedRef.current = true;
                          }
                          onMoveQueued(1);
                        }}
                        title={tr("chat.moveQueuedDown")}
                        aria-label={moveDownName}
                        className="flex h-5 w-5 flex-none items-center justify-center rounded-full text-kin-blue-ink/80 transition-colors hover:bg-kin-blue/15 hover:text-kin-blue-ink focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-kin-focus-ring md:-my-1"
                      >
                        <svg width="10" height="10" viewBox="0 0 10 10" aria-hidden="true">
                          <path
                            d="M3.5 1.5L7 5l-3.5 3.5"
                            stroke="currentColor"
                            strokeWidth="1.4"
                            strokeLinecap="round"
                            strokeLinejoin="round"
                            fill="none"
                          />
                        </svg>
                      </button>
                    )}
                  </>
                )}
                {onEditQueued && (
                  // Beside the ×, because it is the gentler half of the same
                  // thought: take the message back, but keep what it says.
                  //
                  // Both actions take the `.touch-lg` 44px phone floor rather
                  // than the `touch-mini` opt-out: this badge is a primary
                  // mid-run surface, and a thumb a few pixels off these 10px
                  // glyphs must still land on the action it aimed at. The
                  // badge grows to a tap row there; the unchanged `h-5 w-5` and
                  // the `md:`-scoped margins keep the Mac's 20px glyph buttons
                  // and compact pill exactly as they were.
                  <button
                    type="button"
                    onClick={onEditQueued}
                    title={tr("chat.editQueued")}
                    aria-label={editName}
                    className="ml-0.5 flex h-5 w-5 flex-none items-center justify-center rounded-full text-kin-blue-ink/80 transition-colors hover:bg-kin-blue/15 hover:text-kin-blue-ink focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-kin-focus-ring md:-my-1"
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
                  // This one used to opt out of the floor to keep the pill from
                  // becoming a 44px slab. That trade was wrong for this row:
                  // 撤回 discards a message the person had not sent yet and has
                  // no undo, so it needs the full 44×44 phone target. The
                  // sanctioned `touch-mini` home is a control on a tile too
                  // small to grow, like the attachment thumbnail's ×.
                  <button
                    type="button"
                    onClick={onUnqueue}
                    title={tr("chat.withdraw")}
                    aria-label={withdrawName}
                    className="ml-0.5 flex h-5 w-5 flex-none items-center justify-center rounded-full text-kin-blue-ink/80 transition-colors hover:bg-kin-blue/15 hover:text-kin-blue-ink focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-kin-focus-ring md:-my-1 md:-mr-1"
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
          {images && images.length > 0 && <UserAttachments images={images} />}
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

/**
 * Pictures are parsed fresh on every projection, so identity is never equal
 * even when nothing about them changed; compare what they would draw.
 */
function sameImages(a?: readonly UserImage[], b?: readonly UserImage[]): boolean {
  if (a === b) return true;
  if (!a || !b || a.length !== b.length) return false;
  return a.every((image, index) => image.name === b[index].name && image.src === b[index].src);
}

/** Same reasoning as `sameMessage`: compare what is drawn, not the closures. */
export function sameRow(a: MessageRowProps, b: MessageRowProps): boolean {
  return (
    a.messageKey === b.messageKey &&
    a.activeFindKey === b.activeFindKey &&
    a.speaker === b.speaker &&
    a.text === b.text &&
    sameImages(a.images, b.images) &&
    a.partial === b.partial &&
    a.queued === b.queued &&
    // Presence, not identity: the control is there or it is not, and the fresh
    // closure a redraw would bring is not worth one. Same rule `sameMessage`
    // uses for the save button.
    !!a.onUnqueue === !!b.onUnqueue &&
    !!a.onEditQueued === !!b.onEditQueued &&
    // The place and the length are drawn, not just enabling: a reorder that
    // changes them must repaint the row even though nothing else did.
    a.queuePlace === b.queuePlace &&
    a.queueLength === b.queueLength &&
    !!a.onMoveQueued === !!b.onMoveQueued &&
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
      <Button
        onClick={onCopy}
        disabled={disabled}
        className="h-8 rounded-md px-2.5 py-1 text-body font-medium"
      >
        <span className="inline-flex items-center gap-1">
          <IconCopy size={14} />
          {tr("chat.message.copyText")}
        </span>
      </Button>
      <Button
        variant="secondary"
        onClick={onDownload}
        disabled={disabled}
        className="h-8 rounded-md px-2.5 py-1 text-body font-medium hover:bg-[var(--kin-fill)]"
      >
        <span className="inline-flex items-center gap-1">
          <IconDownload size={14} />
          {tr("chat.message.downloadHTML")}
        </span>
      </Button>
      <Button
        variant="quiet"
        onClick={onCancel}
        className="group h-8 rounded-md px-2 py-1 text-body font-medium"
      >
        <span className="text-kin-muted transition-colors group-hover:text-kin-text">
          {tr("chat.message.cancel")}
        </span>
      </Button>
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
