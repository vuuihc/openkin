/**
 * KIN-MOBILE-001 R4b/R4c — the phone's conversation, phone presentation.
 *
 * Pure: it draws the view state `threadModel` produced and nothing else. No
 * fetch, no router, no storage. The composer below the transcript is the one
 * exception to "draws only the model's state": the draft is the person's own
 * text, so it lives here until Send hands it to the model — and the model, not
 * this view, owns `running`, `sendQueue` and `banner`. The pending approvals
 * and questions of *this* task may mount above the transcript through
 * `approvals`, already scoped by the container.
 *
 * The turn shapes are the shared projection's (`ChatItem`, `Turn` from
 * `ui/src/components/chat/transcriptProjection.ts`), so the phone cannot
 * disagree with the web console about what belongs to a turn.
 */

import { useContext, useEffect, useRef, useState } from "react";
import {
  FlatList,
  KeyboardAvoidingView,
  Platform,
  Pressable,
  StyleSheet,
  Text,
  TextInput,
  View,
  type NativeScrollEvent,
  type NativeSyntheticEvent,
} from "react-native";
import {
  SafeAreaInsetsContext,
  type EdgeInsets,
} from "react-native-safe-area-context";
import type {
  ChatItem,
  ToolStep,
  Turn,
} from "../../../ui/src/components/chat/transcriptProjection";
import { canRetry } from "../native/reconnect";
import type {
  ProvidersView,
  UsageWindowDays,
} from "../providers/providersModel";
import { composerBottomInset, headerTopInset } from "../native/insets";
import {
  initialFollow,
  onContentGrew,
  onScroll as followOnScroll,
  type FollowState,
} from "../thread/follow";
import type { ThreadState } from "../thread/threadModel";
import {
  ApprovalsSection,
  type ApprovalsScreenProps,
} from "./Approvals";
import ProviderUsageSheet from "./ProviderUsageSheet";
import { MessageBody } from "./TableBlock";

/** The signed touch floor; every control on this screen meets it. */
export const BACK_SIZE = 44;

/**
 * The metrics of a device that reports no safe area. The view also is rendered
 * on its own, without a provider, by the reading suites; reading the context
 * directly (rather than `useSafeAreaInsets`, which throws) treats that as a
 * device with no inset and keeps the compact header/composer.
 */
const NO_INSETS: EdgeInsets = { top: 0, right: 0, bottom: 0, left: 0 };

export type ConversationViewProps = {
  state: ThreadState;
  t: (key: string, params?: Record<string, string | number>) => string;
  onBack: () => void;
  /** The failed read's retry; absent when there is nothing to retry. */
  onRetry?: () => void;
  /**
   * Reopen the live stream after it gave up (KIN-MOBILE-001 R7). Offered as
   * one press beside the offline banner; absent when there is no thread.
   */
  onReconnect?: () => void;
  /**
   * This task's pending approvals and questions, already scoped by the
   * container; absent when there is no session to read them with.
   */
  approvals?: ApprovalsScreenProps;
  /**
   * Hand the composer's text to the model. Absent when there is no thread to
   * post through, and the composer is not drawn at all.
   */
  onSend?: (text: string) => void;
  /** End the running round; the stopped note comes back from the model. */
  onStop?: () => void;
  /** Drop a queued send the round has not taken yet. */
  onWithdraw?: (id: string) => void;
  /**
   * This conversation's provider/usage sheet, already wired by the container;
   * absent when there is no session to read with, and then the header draws no
   * entry at all. The open/close state is this view's own transient UI, while
   * the data (including the chosen 7/30/90 window) belongs to the model.
   */
  usage?: {
    state: ProvidersView;
    onSelectWindow: (days: UsageWindowDays) => void;
    onRefresh?: () => void;
    /** The sheet opened: the container starts the read. */
    onOpen?: () => void;
    /** The sheet closed: the container drops an in-flight read. */
    onClose?: () => void;
  };
};

/**
 * The catalogue sentence for a failed read, by transport reason — the same
 * mapping the conversation list uses, so one failure never reads two ways.
 */
function errorKey(state: ThreadState): string {
  switch (state.reason) {
    case "expired":
      return "pairing.expired";
    case "rejected":
      return "pairing.rejected";
    case "unreachable":
      return "pairing.unreachable";
    default:
      return "sessions.loadErrorHint";
  }
}

/** What a non-progress item says; a progress item is drawn row by row. */
function itemBody(item: ChatItem): string {
  switch (item.kind) {
    case "message":
      return item.text;
    case "error":
      return item.message;
    case "meta":
      return item.label;
    case "compaction":
      return item.text;
    case "progress":
      return "";
  }
}

type ProgressItem = Extract<ChatItem, { kind: "progress" }>;

/** How much of one recorded field the expanded row draws. */
const DETAIL_LIMIT = 4000;

function bounded(text: string): string {
  return text.length <= DETAIL_LIMIT ? text : `${text.slice(0, DETAIL_LIMIT)}…`;
}

/** The catalogue word for a step's status, from the projection's three states. */
function statusKey(status: ToolStep["status"]): string {
  switch (status) {
    case "running":
      return "chat.progress.running";
    case "error":
      return "chat.progress.failed";
    default:
      return "chat.progress.done";
  }
}

/** An input is whatever the agent sent; draw it as text, never as "[object]". */
function inputText(input: unknown): string {
  if (typeof input === "string") return bounded(input);
  try {
    return bounded(JSON.stringify(input, null, 2) ?? "");
  } catch {
    return "";
  }
}

function hasDetail(step: ToolStep): boolean {
  return step.input !== undefined || !!step.output || !!step.summary;
}

/**
 * A tool call while collapsed: its name and status. Expanded, the call's own
 * recorded input and output — the shared projection already carries them, so
 * nothing is fetched here.
 */
function ToolRow({
  step,
  expanded,
  onToggle,
  t,
}: {
  step: ToolStep;
  expanded: boolean;
  onToggle: () => void;
  t: ConversationViewProps["t"];
}) {
  return (
    <Pressable
      accessibilityRole="button"
      accessibilityState={{ expanded }}
      onPress={onToggle}
      style={styles.toolRow}
      testID={`conversation:tool:${step.key}`}
    >
      <View style={styles.toolHead}>
        <Text numberOfLines={2} style={styles.tool}>
          {step.name}
        </Text>
        <Text style={styles.toolStatus}>{t(statusKey(step.status))}</Text>
        {hasDetail(step) ? (
          <Text style={styles.toolToggle}>
            {t(expanded ? "chat.progress.hide" : "chat.progress.details")}
          </Text>
        ) : null}
      </View>
      {expanded ? (
        <View style={styles.toolDetail}>
          {step.input !== undefined ? (
            <>
              <Text style={styles.detailLabel}>{t("chat.progress.input")}</Text>
              <Text style={styles.detailText}>{inputText(step.input)}</Text>
            </>
          ) : null}
          {step.output ? (
            <>
              <Text style={styles.detailLabel}>{t("chat.progress.output")}</Text>
              <Text style={styles.detailText}>{bounded(step.output)}</Text>
            </>
          ) : null}
          {step.input === undefined && !step.output && step.summary ? (
            <Text style={styles.detailText}>{bounded(step.summary)}</Text>
          ) : null}
        </View>
      ) : null}
    </Pressable>
  );
}

/**
 * A tool row's identity while the thread streams: the step's own key. A live
 * note splitting into its own item shifts every later item's position, so a
 * position-keyed row would collapse under the reader; the positional
 * arguments exist to name what a positional key would have used.
 */
function toolRowKey(
  _turnIndex: number,
  _itemIndex: number,
  stepKey: string,
): string {
  return stepKey;
}

/** One row per step: a note says its text, a tool is a control. */
function ProgressRows({
  item,
  turnIndex,
  itemIndex,
  expandedSteps,
  onToggleStep,
  t,
}: {
  item: ProgressItem;
  turnIndex: number;
  itemIndex: number;
  expandedSteps: Record<string, boolean>;
  onToggleStep: (key: string) => void;
  t: ConversationViewProps["t"];
}) {
  return (
    <View style={styles.progress}>
      {item.steps.map((step) =>
        step.kind === "note" ? (
          <Text key={step.key} numberOfLines={2} style={styles.note}>
            {step.text}
          </Text>
        ) : (
          <ToolRow
            expanded={
              expandedSteps[toolRowKey(turnIndex, itemIndex, step.key)] === true
            }
            key={step.key}
            onToggle={() =>
              onToggleStep(toolRowKey(turnIndex, itemIndex, step.key))
            }
            step={step}
            t={t}
          />
        ),
      )}
    </View>
  );
}

function TurnBlock({
  turn,
  index,
  expandedSteps,
  onToggleStep,
  t,
}: {
  turn: Turn;
  index: number;
  expandedSteps: Record<string, boolean>;
  onToggleStep: (key: string) => void;
  t: ConversationViewProps["t"];
}) {
  if (turn.kind === "user") {
    return (
      <Text style={styles.user} testID={`conversation:turn:${index}`}>
        {turn.item.text}
      </Text>
    );
  }
  const items: ChatItem[] = turn.kind === "agent" ? turn.items : [turn.item];
  return (
    <View style={styles.turn} testID={`conversation:turn:${index}`}>
      {items.map((item, itemIndex) =>
        item.kind === "progress" ? (
          <ProgressRows
            expandedSteps={expandedSteps}
            item={item}
            itemIndex={itemIndex}
            key={`${index}:${item.key}`}
            onToggleStep={onToggleStep}
            t={t}
            turnIndex={index}
          />
        ) : item.kind === "message" ? (
          // A message may hold a markdown table (KIN-MOBILE-001 R4); with no
          // table its body is still the one <Text> it was.
          <MessageBody
            key={`${index}:${item.key}`}
            text={item.text}
            textStyle={styles.item}
          />
        ) : (
          <Text
            key={`${index}:${item.key}`}
            style={item.kind === "error" ? styles.errorItem : styles.item}
          >
            {itemBody(item)}
          </Text>
        ),
      )}
    </View>
  );
}

type ComposerProps = {
  state: ThreadState;
  t: ConversationViewProps["t"];
  onSend: (text: string) => void;
  onStop?: () => void;
  onWithdraw?: (id: string) => void;
  /** This device's home-indicator clearance (see `composerBottomInset`). */
  bottomPadding: number;
};

/**
 * The draft is this component's own state and is tagged with the task it was
 * typed for: a screen that swapped conversations draws an empty box, so the
 * old words can neither return nor be posted under the new task (AGENTS.md
 * §11). A failed read, a stream event or a queued send repaints the view
 * without touching this state — that is what "offline keeps the draft" means.
 */
function Composer({
  state,
  t,
  onSend,
  onStop,
  onWithdraw,
  bottomPadding,
}: ComposerProps) {
  const [draft, setDraft] = useState({ taskId: state.taskId, text: "" });
  const text = draft.taskId === state.taskId ? draft.text : "";
  const offline = state.banner === "offline";
  // An offline node takes nothing, so Send is closed; the transcript above
  // states why. An empty box has nothing to send.
  const canSend = text.trim().length > 0 && !offline;

  const send = (): void => {
    const trimmed = text.trim();
    if (!trimmed || offline) return;
    // The words go to the model, not into the box: clear first, so the next
    // thought is never appended to the one already sent. The guard above is
    // what keeps them when the node cannot take them at all.
    setDraft({ taskId: state.taskId, text: "" });
    onSend(trimmed);
  };

  return (
    <View
      style={[styles.composer, { paddingBottom: bottomPadding }]}
      testID="conversation:composerBar"
    >
      {state.sendQueue.length > 0 ? (
        <View style={styles.queue}>
          {state.sendQueue.map((item) => (
            <View key={item.id} style={styles.queueRow}>
              <View style={styles.queueWords}>
                <Text style={styles.queueLabel}>{t("chat.queued")}</Text>
                <Text numberOfLines={2} style={styles.queueText}>
                  {item.text}
                </Text>
              </View>
              <Pressable
                accessibilityLabel={t("chat.withdrawNamed", {
                  text: item.text,
                })}
                accessibilityRole="button"
                onPress={() => onWithdraw?.(item.id)}
                style={styles.withdraw}
                testID={`conversation:withdraw:${item.id}`}
              >
                <Text numberOfLines={2} style={styles.withdrawText}>
                  {t("chat.withdraw")}
                </Text>
              </Pressable>
            </View>
          ))}
        </View>
      ) : null}
      <View style={styles.composerRow}>
        <TextInput
          accessibilityLabel={t("composer.placeholder")}
          multiline
          onChangeText={(next) => setDraft({ taskId: state.taskId, text: next })}
          placeholder={t("composer.placeholder")}
          placeholderTextColor="#8a8a8a"
          style={styles.input}
          testID="conversation:composer"
          value={text}
        />
        <Pressable
          accessibilityRole="button"
          accessibilityState={{ disabled: !canSend }}
          disabled={!canSend}
          onPress={send}
          style={[styles.action, !canSend && styles.actionDisabled]}
          testID="conversation:send"
        >
          <Text style={canSend ? styles.actionText : styles.actionTextDisabled}>
            {t("composer.send")}
          </Text>
        </Pressable>
        {state.running ? (
          <Pressable
            accessibilityRole="button"
            accessibilityState={{ disabled: offline }}
            disabled={offline}
            onPress={() => onStop?.()}
            style={[styles.action, offline && styles.actionDisabled]}
            testID="conversation:stop"
          >
            <Text
              style={offline ? styles.actionTextDisabled : styles.actionText}
            >
              {t("composer.stop")}
            </Text>
          </Pressable>
        ) : null}
      </View>
    </View>
  );
}

export default function ConversationView({
  state,
  t,
  onBack,
  onRetry,
  onReconnect,
  approvals,
  onSend,
  onStop,
  onWithdraw,
  usage,
}: ConversationViewProps) {
  // The device's own insets; a missing provider is a device that reports none.
  const insets = useContext(SafeAreaInsetsContext) ?? NO_INSETS;

  // Whether the sheet is up is the person's own transient UI, so it lives in
  // this view; the window choice and the rows are the model's (AGENTS.md §11).
  const [usageOpen, setUsageOpen] = useState(false);
  // The reading surface's own transient UI: which tool rows are open. Keyed by
  // the step's key (see `toolRowKey`), so a streamed append cannot collapse a
  // row the person opened; a different conversation starts closed.
  const [expandedSteps, setExpandedSteps] = useState<Record<string, boolean>>(
    {},
  );
  // Following the live edge is a scroll decision, not React state: it changes
  // on every scroll frame and must never repaint the transcript (AGENTS.md §11).
  const follow = useRef<FollowState>(initialFollow());
  const listRef = useRef<FlatList<Turn>>(null);
  // The thread whose first layout was already scrolled to the end, and the last
  // content height seen, so "grew" is a comparison rather than a guess.
  const openedFor = useRef<string | null>(null);
  const lastContentHeight = useRef(0);

  useEffect(() => {
    follow.current = initialFollow();
    openedFor.current = null;
    lastContentHeight.current = 0;
    setExpandedSteps({});
  }, [state.taskId]);

  const toggleStep = (key: string): void => {
    setExpandedSteps((current) => ({ ...current, [key]: current[key] !== true }));
  };

  const handleScroll = (
    event: NativeSyntheticEvent<NativeScrollEvent>,
  ): void => {
    const { contentOffset, contentSize, layoutMeasurement } = event.nativeEvent;
    follow.current = followOnScroll(follow.current, {
      offset: contentOffset.y,
      contentHeight: contentSize.height,
      viewportHeight: layoutMeasurement.height,
    });
  };

  const handleContentSize = (_width: number, height: number): void => {
    const previous = lastContentHeight.current;
    lastContentHeight.current = height;
    // The first laid-out content is where a conversation opens at its newest
    // segment; the list arrives here without turns while the read is pending.
    if (openedFor.current !== state.taskId) {
      if (state.turns.length === 0 || height <= 0) return;
      openedFor.current = state.taskId;
      listRef.current?.scrollToEnd({ animated: false });
      return;
    }
    // Growth while the reader is away from the end must not move the page.
    if (height <= previous) return;
    if (onContentGrew(follow.current).scrollToEnd) {
      listRef.current?.scrollToEnd({ animated: false });
    }
  };

  // A conversation draws no approval chrome when there is nothing to say: no
  // card and no empty state, exactly as an unblocked turn reads today.
  const showApprovals =
    approvals !== undefined &&
    (approvals.state.items.length > 0 ||
      approvals.state.status === "loading" ||
      approvals.state.status === "error" ||
      !approvals.state.online);

  // The list header keeps the read's notices above the turns and outside the
  // virtualized cells, so a repaint of the transcript cannot unmount them.
  const listHeader = (
    <>
      {state.status === "loading" ? (
        <Text style={styles.notice}>{t("common.loading")}</Text>
      ) : null}
      {state.status === "error" ? (
        <View style={styles.failed}>
          <Text accessibilityRole="alert" style={styles.failure}>
            {t(errorKey(state))}
          </Text>
          {onRetry ? (
            <Pressable
              accessibilityRole="button"
              onPress={onRetry}
              style={styles.retry}
              testID="conversation:retry"
            >
              <Text style={styles.retryText}>{t("pairing.retry")}</Text>
            </Pressable>
          ) : null}
        </View>
      ) : state.banner === "offline" ? (
        // A refresh that failed with the turns already read keeps them and
        // says why above them; the error block above owns the empty case.
        // R7: the dead stream offers exactly one manual retry beside the
        // sentence, so the reader never has to leave the conversation to get
        // live updates back.
        <View style={styles.failed}>
          <Text accessibilityRole="alert" style={styles.notice}>
            {t("pairing.unreachable")}
          </Text>
          {onReconnect && canRetry(state) ? (
            <Pressable
              accessibilityRole="button"
              onPress={onReconnect}
              style={styles.retry}
              testID="conversation:reconnect"
            >
              <Text style={styles.retryText}>{t("pairing.retry")}</Text>
            </Pressable>
          ) : null}
        </View>
      ) : null}
      {showApprovals && approvals ? (
        // Above the turns: this is what the next turn is waiting on. The
        // section is scroller-free, so it lives in the list header.
        <ApprovalsSection {...approvals} embedded />
      ) : null}
    </>
  );
  return (
    // The keyboard-avoiding box wraps the transcript and the composer: on iOS
    // its padding moves the composer above the keyboard and shrinks the
    // transcript; on Android the box shrinks by the keyboard's height.
    <KeyboardAvoidingView
      behavior={Platform.OS === "ios" ? "padding" : "height"}
      keyboardVerticalOffset={0}
      style={styles.container}
    >
      <View
        style={[styles.header, { paddingTop: headerTopInset(insets.top) }]}
        testID="conversation:header"
      >
        <Pressable
          accessibilityLabel={t("app.back")}
          accessibilityRole="button"
          onPress={onBack}
          style={styles.back}
          testID="conversation:back"
        >
          <Text style={styles.backText}>{t("app.back")}</Text>
        </Pressable>
        {state.running ? (
          <Text style={styles.running}>{t("sessions.statusRunning")}</Text>
        ) : null}
        {usage !== undefined ? (
          // The sheet's entry: no overflow menu exists yet, so the signed
          // "用量" control stands on its own at the header's trailing edge.
          <Pressable
            accessibilityLabel={t("usage.openPhone")}
            accessibilityRole="button"
            onPress={() => {
              setUsageOpen(true);
              usage.onOpen?.();
            }}
            style={styles.usageEntry}
            testID="conversation:usage"
          >
            <Text style={styles.usageEntryText}>{t("usage.title")}</Text>
          </Pressable>
        ) : null}
      </View>
      <FlatList
        contentContainerStyle={styles.body}
        data={state.turns}
        initialNumToRender={10}
        keyExtractor={(_turn, index) => `${state.taskId}:${index}`}
        ListHeaderComponent={listHeader}
        onContentSizeChange={handleContentSize}
        onScroll={handleScroll}
        ref={listRef}
        renderItem={({ item, index }) => (
          <TurnBlock
            expandedSteps={expandedSteps}
            index={index}
            onToggleStep={toggleStep}
            t={t}
            turn={item}
          />
        )}
        scrollEventThrottle={16}
        style={styles.scroller}
        testID="conversation:turns"
      />
      {onSend ? (
        // A sibling of the scroller, not a row inside it: the composer is
        // reachable at every scroll position.
        <Composer
          bottomPadding={composerBottomInset(insets.bottom)}
          onSend={onSend}
          onStop={onStop}
          onWithdraw={onWithdraw}
          state={state}
          t={t}
        />
      ) : null}
      {usage !== undefined ? (
        // A sibling of the scroller too: closing the sheet leaves the
        // transcript mounted exactly where it was, never re-read.
        <ProviderUsageSheet
          onClose={() => {
            setUsageOpen(false);
            usage.onClose?.();
          }}
          onRefresh={usage.onRefresh}
          onSelectWindow={usage.onSelectWindow}
          state={usage.state}
          t={t}
          visible={usageOpen}
        />
      ) : null}
    </KeyboardAvoidingView>
  );
}

const styles = StyleSheet.create({
  action: {
    alignItems: "center",
    justifyContent: "center",
    minHeight: BACK_SIZE,
    minWidth: BACK_SIZE,
    paddingHorizontal: 12,
  },
  actionDisabled: {
    opacity: 0.5,
  },
  actionText: {
    color: "#0b57d0",
    fontSize: 15,
    fontWeight: "600",
  },
  actionTextDisabled: {
    color: "#6b6b6b",
    fontSize: 15,
    fontWeight: "600",
  },
  back: {
    alignItems: "center",
    borderRadius: 8,
    justifyContent: "center",
    minHeight: BACK_SIZE,
    minWidth: BACK_SIZE,
    paddingHorizontal: 12,
  },
  backText: {
    color: "#0b57d0",
    fontSize: 16,
    fontWeight: "600",
  },
  body: {
    gap: 12,
    padding: 16,
    paddingBottom: 48,
  },
  composer: {
    borderTopColor: "#dcdcdc",
    borderTopWidth: StyleSheet.hairlineWidth,
    gap: 8,
    paddingHorizontal: 16,
    paddingTop: 8,
  },
  composerRow: {
    alignItems: "flex-end",
    flexDirection: "row",
    gap: 8,
  },
  container: {
    flex: 1,
  },
  detailLabel: {
    color: "#6b6b6b",
    fontSize: 12,
    fontWeight: "600",
  },
  detailText: {
    color: "#3a3a3a",
    fontSize: 13,
  },
  errorItem: {
    color: "#a1261b",
    fontSize: 15,
  },
  failed: {
    gap: 8,
  },
  failure: {
    color: "#a1261b",
    fontSize: 15,
  },
  header: {
    alignItems: "center",
    flexDirection: "row",
    gap: 8,
    minHeight: 56,
    paddingHorizontal: 4,
  },
  input: {
    borderColor: "#c4c4c4",
    borderRadius: 8,
    borderWidth: 1,
    color: "#1d1d1d",
    flex: 1,
    fontSize: 16,
    maxHeight: 120,
    minHeight: BACK_SIZE,
    paddingHorizontal: 12,
    paddingVertical: 10,
  },
  item: {
    color: "#1d1d1d",
    fontSize: 16,
  },
  note: {
    color: "#555555",
    fontSize: 14,
    fontStyle: "italic",
  },
  notice: {
    color: "#555555",
    fontSize: 15,
  },
  progress: {
    borderLeftColor: "#dcdcdc",
    borderLeftWidth: 2,
    gap: 4,
    paddingLeft: 12,
  },
  queue: {
    gap: 4,
  },
  queueLabel: {
    color: "#6b6b6b",
    fontSize: 12,
    fontWeight: "600",
  },
  queueRow: {
    alignItems: "center",
    flexDirection: "row",
    gap: 8,
  },
  queueText: {
    color: "#1d1d1d",
    fontSize: 15,
  },
  queueWords: {
    flex: 1,
    gap: 2,
  },
  retry: {
    alignItems: "center",
    alignSelf: "flex-start",
    justifyContent: "center",
    minHeight: BACK_SIZE,
    minWidth: BACK_SIZE,
    paddingHorizontal: 12,
  },
  retryText: {
    color: "#0b57d0",
    fontSize: 15,
    fontWeight: "600",
  },
  running: {
    color: "#6b6b6b",
    fontSize: 13,
    fontWeight: "600",
  },
  scroller: {
    flex: 1,
  },
  tool: {
    color: "#3a3a3a",
    flexShrink: 1,
    fontSize: 14,
    fontWeight: "500",
  },
  toolDetail: {
    gap: 6,
    paddingTop: 6,
  },
  toolHead: {
    alignItems: "center",
    flexDirection: "row",
    gap: 8,
  },
  toolRow: {
    borderColor: "#dcdcdc",
    borderRadius: 8,
    borderWidth: StyleSheet.hairlineWidth,
    gap: 2,
    justifyContent: "center",
    minHeight: BACK_SIZE,
    paddingHorizontal: 10,
    paddingVertical: 8,
  },
  toolStatus: {
    color: "#6b6b6b",
    fontSize: 12,
    fontWeight: "600",
  },
  toolToggle: {
    color: "#0b57d0",
    fontSize: 12,
    fontWeight: "600",
    marginLeft: "auto",
  },
  turn: {
    gap: 8,
  },
  user: {
    color: "#1d1d1d",
    fontSize: 16,
    fontWeight: "600",
    marginTop: 8,
  },
  usageEntry: {
    alignItems: "center",
    justifyContent: "center",
    // Trailing edge: the back control stays left and this is the only
    // right-hand control in the header.
    marginLeft: "auto",
    minHeight: BACK_SIZE,
    minWidth: BACK_SIZE,
    paddingHorizontal: 12,
  },
  usageEntryText: {
    color: "#0b57d0",
    fontSize: 15,
    fontWeight: "600",
  },
  withdraw: {
    alignItems: "center",
    justifyContent: "center",
    minHeight: BACK_SIZE,
    minWidth: BACK_SIZE,
    paddingHorizontal: 8,
  },
  withdrawText: {
    color: "#0b57d0",
    fontSize: 13,
    fontWeight: "600",
  },
});
