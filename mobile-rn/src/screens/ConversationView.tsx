/**
 * KIN-MOBILE-001 R4b/R4c — the phone's conversation, phone presentation.
 *
 * Pure: it draws the view state `threadModel` produced and nothing else. No
 * fetch, no router, no storage. The composer below the transcript is the one
 * exception to "draws only the model's state": the draft is the person's own
 * text, so it lives here until Send hands it to the model — and the model, not
 * this view, owns `running`, `sendQueue` and `banner`. The pending approvals
 * and questions of *this* task may dock above the composer through
 * `approvals`, already scoped by the container.
 *
 * The turn shapes are the shared projection's (`ChatItem`, `Turn` from
 * `ui/src/components/chat/transcriptProjection.ts`), so the phone cannot
 * disagree with the web console about what belongs to a turn.
 */

import { useContext, useEffect, useMemo, useRef, useState } from "react";
import {
  ActivityIndicator,
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
  type ViewInstance,
} from "react-native";
import {
  SafeAreaInsetsContext,
  type EdgeInsets,
} from "react-native-safe-area-context";
import {
  shouldShowGenericThinking,
  type ChatItem,
  type ToolStep,
  type Turn,
} from "../../../ui/src/components/chat/transcriptProjection";
import { focusNode } from "../a11y/focus";
import { useTheme } from "../theme/useTheme";
import { radius, type Palette } from "../theme/tokens";
import { canRetry } from "../native/reconnect";
import {
  sharedDraftMemory,
  type DraftMemory,
} from "../thread/draftMemory";
import type {
  ProvidersView,
  UsageWindowDays,
} from "../providers/providersModel";
import {
  composerBottomInset,
  HEADER_ROW_HEIGHT,
  headerTopInset,
  headerTotalHeight,
} from "../native/insets";
import GlassSurface, { useReduceTransparency } from "../native/GlassSurface";
import { glassFor } from "../native/glass";
import {
  initialFollow,
  onContentGrew,
  onScroll as followOnScroll,
  type FollowState,
} from "../thread/follow";
import {
  sharedReadingMemory,
  type ReadingMemory,
  type ReadingPlace,
} from "../thread/readingMemory";
import {
  lastAgentTurnIndex,
  roundEndedUncleanly,
  spineFor,
  type SpineContext,
  type SpineTone,
} from "../thread/turnSpine";
import type { SendOutcome, ThreadState } from "../thread/threadModel";
import {
  ApprovalsSection,
  type ApprovalsScreenProps,
} from "./Approvals";
import ConversationSkeleton from "./ConversationSkeleton";
import ProviderUsageSheet from "./ProviderUsageSheet";
import { MessageBody } from "./MarkdownBody";

/** The signed touch floor; every control on this screen meets it. */
export const BACK_SIZE = 44;

/**
 * DESIGN.md's mono row — a tool line, its command and its arguments. The same
 * platform select as `MarkdownBody`'s fenced code, so the two cannot disagree.
 */
const MONO = Platform.select({ ios: "Menlo", default: "monospace" });

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
   * Hand the composer's text to the model and answer with what the node said
   * (`SendOutcome`). The composer keeps a refused send's words and names the
   * reason; an accepted send clears the box, exactly as before. A handler that
   * reports nothing is not a refusal, so the box stays cleared as it shipped.
   * Absent when there is no thread to post through, and the composer is not
   * drawn at all.
   */
  onSend?: (text: string) => unknown;
  /** End the running round; the stopped note comes back from the model. */
  onStop?: () => void;
  /** Drop a queued send the round has not taken yet. */
  onWithdraw?: (id: string) => void;
  /**
   * The words each conversation's composer keeps while its route is gone
   * (KIN-MOBILE-001 §5 离开再回来). Injected like the list's memory; the app
   * hands in its one shared store, so Back and a re-open land on the same
   * words. A harness rendering the view alone gets the shared store.
   */
  draftMemory?: DraftMemory;
  /**
   * Where each conversation was left, so a re-opened route lands where the
   * reader was (KIN-MOBILE-001 §3/§4 离开再回来). Injected like the composer's
   * memory; the app hands in its one shared store, so Back and a re-open land
   * on the same place. A harness rendering the view alone gets the shared
   * store.
   */
  readingMemory?: ReadingMemory;
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
 * Why a send the node refused, as the model reports it; the transport half of
 * the union is what a failed read carries too.
 */
type SendFailure = Extract<SendOutcome, { ok: false }>["reason"];

/**
 * The model's answer to a send, when the handler gave one. The handler is an
 * injected boundary — the container answers `SendOutcome`, while a suite may
 * hand in a bare mock — so the shape is checked here once and narrowed, rather
 * than trusted at the call site.
 */
function sendAnswer(value: unknown): SendOutcome | void {
  if (typeof value !== "object" || value === null || !("ok" in value)) {
    return undefined;
  }
  return value as SendOutcome;
}

/**
 * The catalogue sentence for a failure, by the reason the model reported —
 * the same mapping the conversation list uses, so one failure never reads two
 * ways. A refused send and a failed read speak one sentence for one reason;
 * a reason with no transport sentence of its own (`offline`, `stale`, `empty`)
 * falls back to the read hint.
 */
function reasonKey(reason: SendFailure | null): string {
  switch (reason) {
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

/**
 * The projection's turns as the flat item list the shared predicates read: a
 * person's or standalone turn is its one item, an agent turn its column.
 */
function transcriptItems(turns: Turn[]): ChatItem[] {
  return turns.flatMap((turn) =>
    turn.kind === "agent" ? turn.items : [turn.item],
  );
}

/**
 * KIN-MOBILE-001 §3 空 — a settled conversation whose last turn is still the
 * person's never got an answer: the run died, was interrupted, or ended with
 * no reply. The transcript then reads as if the app lost the answer, so one
 * line says so in the spot the live round's thinking row owns.
 *
 * The four gates are the whole contract: a read that has not settled owns no
 * claim about an answer, the first load's skeleton owns the unread transcript,
 * an open round belongs to the thinking row (#779, TASTE 15), and a
 * conversation that already ends with the agent needs no note.
 */
export function shouldShowNoAnswer(state: ThreadState): boolean {
  return (
    state.status === "ready" &&
    !state.running &&
    state.turns.length > 0 &&
    state.turns[state.turns.length - 1].kind === "user"
  );
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
  const { colors } = useTheme();
  const styles = useMemo(() => makeStyles(colors), [colors]);
  return (
    <Pressable
      accessibilityRole="button"
      accessibilityState={{ expanded }}
      onPress={onToggle}
      style={styles.toolRow}
      testID={`conversation:tool:${step.key}`}
    >
      <View style={styles.toolHead}>
        <Text numberOfLines={1} ellipsizeMode="tail" style={styles.tool}>
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
  const { colors } = useTheme();
  const styles = useMemo(() => makeStyles(colors), [colors]);
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

/**
 * The border a tone paints. The tone map uses the pigments that do not switch
 * with the scheme (DESIGN.md 活动脊: blue runs, green done, red failed or
 * stopped, orange waiting on an approval).
 */
function spineStyle(tone: SpineTone, styles: ReturnType<typeof makeStyles>) {
  return {
    approval: styles.spineApproval,
    done: styles.spineDone,
    failed: styles.spineFailed,
    running: styles.spineRunning,
  }[tone];
}

function TurnBlock({
  turn,
  index,
  spine,
  expandedSteps,
  onToggleStep,
  t,
}: {
  turn: Turn;
  index: number;
  /** The thread-level facts the spine's decision table reads. */
  spine: SpineContext;
  expandedSteps: Record<string, boolean>;
  onToggleStep: (key: string) => void;
  t: ConversationViewProps["t"];
}) {
  const { colors } = useTheme();
  const styles = useMemo(() => makeStyles(colors), [colors]);
  // The colours the markdown renderer needs but does not own (KIN-MOBILE-002
  // R4a/R4b); drawn from the palette, never spelled here (R1b).
  const markdownStyles = useMemo(
    () => ({
      blueInk: colors.blueInk,
      codeBackground: colors.fill,
      fillStrong: colors.fillStrong,
      hairline: colors.hairlineStrong,
    }),
    [colors],
  );
  const tone = spineFor(turn, index, spine);
  if (turn.kind === "user") {
    return (
      <View style={styles.bubble} testID={`conversation:turn:${index}`}>
        <Text style={styles.bubbleText}>{turn.item.text}</Text>
      </View>
    );
  }
  const items: ChatItem[] = turn.kind === "agent" ? turn.items : [turn.item];
  return (
    <View
      style={[styles.turn, tone !== null && spineStyle(tone, styles)]}
      testID={`conversation:turn:${index}`}
    >
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
          // A message may hold block markdown and a table (KIN-MOBILE-002
          // R4a, KIN-MOBILE-001 R4); with no block syntax its body is still
          // the one <Text> it was.
          <MessageBody
            key={`${index}:${item.key}`}
            styles={markdownStyles}
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
  /** The words that outlive this component, keyed by conversation. */
  draftMemory: DraftMemory;
  /**
   * A pending 批准 already owns the screen's one filled primary
   * (DESIGN.md:47), so Send keeps its outline even with a draft.
   */
  primaryTaken: boolean;
};

/**
 * The draft is the person's own text. Its live copy is component state tagged
 * with the task it was typed for, and its copy for the next mount is the
 * injected `DraftMemory` (KIN-MOBILE-001 §5 离开再回来): Back pops the route,
 * and reopening reads the words back. The task tag stays, so a screen that
 * swapped conversations draws an empty box rather than another conversation's
 * words (AGENTS.md §11). A failed read, a stream event or a queued send
 * repaints the view without touching the draft — that is what "offline keeps
 * the draft" means.
 *
 * A press clears the box as it always has, and the model's answer decides
 * whether the words come back: a send the node refused restores them in the
 * box and in the memory, and names the reason in one line (KIN-MOBILE-001 §5
 * 失败), while an accepted send leaves both empty for the next thought.
 * A message typed while the first post is still in flight is what could post
 * twice — the empty box no longer guards it, so the in-flight guard has to be
 * explicit.
 */
function Composer({
  state,
  t,
  onSend,
  onStop,
  onWithdraw,
  draftMemory,
  primaryTaken,
}: ComposerProps) {
  const { colors } = useTheme();
  const styles = useMemo(() => makeStyles(colors), [colors]);
  // The box opens on the words this conversation left behind: the route may
  // have popped since they were typed.
  const [draft, setDraft] = useState(() => ({
    taskId: state.taskId,
    text: draftMemory.read(state.taskId),
  }));
  const text = draft.taskId === state.taskId ? draft.text : "";
  const offline = state.banner === "offline";
  // The post this composer is waiting on. A ref, not only the disabled state
  // below: two taps in one frame both read the last rendered `sending` before
  // React repaints, and the guard must hold for the second one too.
  const inFlight = useRef(false);
  // A post answers on the node's time, so it can land after the screen left;
  // the words then belong to nobody and are dropped (AGENTS.md §11).
  const live = useRef(true);
  useEffect(() => {
    live.current = true;
    return () => {
      live.current = false;
    };
  }, []);
  const [sending, setSending] = useState(false);
  // The last refused send's reason, tagged with the task it was typed for so a
  // swapped conversation never shows another conversation's failure.
  const [failure, setFailure] = useState<{
    taskId: string;
    reason: SendFailure;
  } | null>(null);
  // An offline node takes nothing, so Send is closed; the transcript above
  // states why. An empty box has nothing to send, and a post already in flight
  // must not be posted a second time.
  const canSend = text.trim().length > 0 && !offline && !sending;
  // The screen's one filled primary (DESIGN.md:47): a draft makes Send it,
  // unless a waiting 批准 already holds that role — then Send stays the
  // outlined circle beside it.
  const filled = canSend && !primaryTaken;

  /**
   * The post came back. A refusal puts the words back into a box the person
   * has not already filled with a newer thought, and names the reason; words
   * typed during the flight win, because they are the draft now. The memory
   * gets the same restored words, so a leave after the refusal still finds
   * them. An answer that reports nothing is not a refusal, so it changes
   * nothing.
   */
  const settle = (
    forTask: string,
    sent: string,
    answer: unknown,
  ): void => {
    inFlight.current = false;
    if (!live.current) return;
    setSending(false);
    const outcome = sendAnswer(answer);
    if (outcome === undefined || outcome.ok) return;
    // A newer thought in the memory is the draft now, so the refusal must not
    // replace it with the words the node turned down.
    if (draftMemory.read(forTask) === "") {
      draftMemory.write(forTask, sent);
    }
    setDraft((current) =>
      current.taskId === forTask && current.text === ""
        ? { taskId: forTask, text: sent }
        : current,
    );
    setFailure({ taskId: forTask, reason: outcome.reason });
  };

  const send = (): void => {
    const trimmed = text.trim();
    if (!trimmed || offline || inFlight.current) return;
    const forTask = state.taskId;
    inFlight.current = true;
    setSending(true);
    setFailure(null);
    // The words go to the model, not into the box: clear first, so the next
    // thought is never appended to the one already sent. The memory clears
    // with it, so a re-opened conversation shows an empty box. The guard above
    // is what keeps them when the node cannot take them at all.
    draftMemory.write(forTask, "");
    setDraft({ taskId: forTask, text: "" });
    void Promise.resolve(onSend(trimmed)).then((outcome) =>
      settle(forTask, trimmed, outcome),
    );
  };

  return (
    <View style={styles.composer} testID="conversation:composerBar">
      {/*
        The capsule's surface is the system material, not paint: it sits
        behind the queue, the draft and Send, and the bar itself stays
        transparent so the transcript scrolling beneath it is what tints the
        glass (the header's switch). The capsule's `overflow: hidden` clips it
        to the signed 22pt radius.
      */}
      <GlassSurface material="composer" style={StyleSheet.absoluteFill} />
      {state.sendQueue.length > 0 ? (
        <View style={styles.queue} testID="conversation:queue">
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
      {failure !== null && failure.taskId === state.taskId ? (
        // One line beside the draft, the same size and colour as the offline
        // notice above (TASTE: not a card, not a new visual object). The
        // sentence is the catalogue's for the reason the model reported, so a
        // refusal and a failed read never describe one cause two ways.
        <Text
          accessibilityRole="alert"
          style={styles.notice}
          testID="conversation:sendFailure"
        >
          {t(reasonKey(failure.reason))}
        </Text>
      ) : null}
      <View style={styles.composerRow}>
        <TextInput
          accessibilityLabel={t("composer.placeholder")}
          multiline
          onChangeText={(next) => {
            // The memory is the copy the next mount reads, so a change writes
            // both; an emptied box forgets its entry.
            draftMemory.write(state.taskId, next);
            setDraft({ taskId: state.taskId, text: next });
            // Typing is a new attempt: the last refusal described words that
            // are no longer the draft.
            setFailure(null);
          }}
          placeholder={t("composer.placeholder")}
          placeholderTextColor={colors.muted}
          style={styles.input}
          testID="conversation:composer"
          value={text}
        />
        <Pressable
          accessibilityRole="button"
          // `busy` is the slow node speaking: the control is closed while a
          // post is in flight, and a person who tapped once must be able to
          // tell a slow send from a dead one (KIN-MOBILE-001 §5 慢).
          accessibilityState={{ disabled: !canSend, busy: sending }}
          disabled={!canSend}
          onPress={send}
          style={[
            styles.circle,
            filled && styles.circleFilled,
            !canSend && styles.circleDisabled,
          ]}
          testID="conversation:send"
        >
          {sending ? (
            // The platform indicator, over the label's own box: a local cue,
            // not a new surface, and the box above stays editable meanwhile.
            // The word stays in the layout (and out of the reader) so the
            // control keeps its width when the cue replaces it.
            <View style={styles.sendingCue}>
              <Text
                aria-hidden
                style={[styles.circleLabel, styles.circleLabelHidden]}
              >
                {t("composer.send")}
              </Text>
              <ActivityIndicator
                accessibilityLabel={t("composer.sending")}
                style={StyleSheet.absoluteFill}
                testID="conversation:sending"
              />
            </View>
          ) : (
            // The circle speaks through fill and ink — brand fill with ink on
            // brand while a draft exists, the outlined circle otherwise — and
            // the closed state through opacity, never through colour alone.
            <Text
              style={[styles.circleLabel, filled && styles.circleLabelFilled]}
            >
              {t("composer.send")}
            </Text>
          )}
        </Pressable>
        {state.running ? (
          <Pressable
            accessibilityRole="button"
            accessibilityState={{ disabled: offline }}
            disabled={offline}
            onPress={() => onStop?.()}
            style={[
              styles.circle,
              styles.stopCircle,
              offline && styles.circleDisabled,
            ]}
            testID="conversation:stop"
          >
            <Text style={[styles.circleLabel, styles.stopCircleLabel]}>
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
  draftMemory = sharedDraftMemory,
  readingMemory = sharedReadingMemory,
  usage,
}: ConversationViewProps) {
  // The device's own insets; a missing provider is a device that reports none.
  const insets = useContext(SafeAreaInsetsContext) ?? NO_INSETS;

  // The bar's surface, from the same preference the usage sheet reads:
  // reduced transparency and Android keep today's opaque bar, every other
  // phone blurs the transcript that scrolls beneath it (`native/glass.ts`).
  const { colors, scheme } = useTheme();
  const glass = glassFor({
    reduceTransparency: useReduceTransparency(),
    platform: Platform.OS,
    scheme,
  });
  // Only the opaque branch reads this; the blur branch paints transparent.
  const glassColor = glass.kind === "opaque" ? glass.color : "transparent";
  const styles = useMemo(
    () => makeStyles(colors, glassColor),
    [colors, glassColor],
  );

  // Whether the sheet is up is the person's own transient UI, so it lives in
  // this view; the window choice and the rows are the model's (AGENTS.md §11).
  const [usageOpen, setUsageOpen] = useState(false);
  // The 用量 entry that opened the sheet: closing it puts the reader back on
  // this control, not wherever the vanished modal left them
  // (`KIN-MOBILE-001.md:124`). It is the header's own node, so the return move
  // lives in this view rather than in the sheet (`ProviderUsageSheet.tsx`).
  const usageRef = useRef<ViewInstance | null>(null);
  // Whether the sheet was up on the previous render, so the return move fires
  // on the close transition only: a mount with the sheet closed and a repaint
  // while it stays closed move nothing (`Approvals.tsx:70-79`, AGENTS.md §11).
  const usageWasOpen = useRef(false);
  // The reading surface's own transient UI: which tool rows are open. Keyed by
  // the step's key (see `toolRowKey`), so a streamed append cannot collapse a
  // row the person opened; a different conversation starts closed.
  const [expandedSteps, setExpandedSteps] = useState<Record<string, boolean>>(
    {},
  );
  // Following the live edge is a scroll decision, not React state: it changes
  // on every scroll frame and must never repaint the transcript (AGENTS.md §11).
  const follow = useRef<FollowState>(initialFollow());
  // The place the reader was last seen at, beside the follow flag and for the
  // same reason: a scroll frame must never repaint the transcript (AGENTS.md
  // §11). The leave cleanup below writes it to the injected memory.
  const place = useRef<ReadingPlace | null>(null);
  // The offset a restore is still travelling to, or null when no restore is in
  // flight. A virtualized list lays out only its first window without
  // `getItemLayout`, so a deep place's first `scrollToOffset` clamps short of
  // it: while set, a scroll frame is that clamp rather than the reader, and
  // growth re-issues the move instead of following the end
  // (`ui/src/components/mobile/MobileList.tsx:70-82`, `:154-160`).
  const restoring = useRef<number | null>(null);
  const listRef = useRef<FlatList<Turn>>(null);
  // The conversation's name: the node the reader is placed on at entry.
  const titleRef = useRef<ViewInstance | null>(null);
  // The conversation whose entry move already happened: one entry is one
  // reader move, so a title that settles late cannot move it a second time.
  const movedFor = useRef<string | null>(null);
  // The thread whose first layout was already scrolled to the end, and the last
  // content height seen, so "grew" is a comparison rather than a guess.
  const openedFor = useRef<string | null>(null);
  const lastContentHeight = useRef(0);

  useEffect(() => {
    follow.current = initialFollow();
    restoring.current = null;
    openedFor.current = null;
    lastContentHeight.current = 0;
    setExpandedSteps({});
  }, [state.taskId]);

  // The place this mount last observed belongs to the task it was observed in
  // (AGENTS.md §11): the task id is captured here, so a route swap stores the
  // old conversation's place under the old id rather than the new one's. A
  // mount the reader never scrolled stores nothing, so a conversation opened
  // and left at its newest segment reopens there.
  useEffect(() => {
    const forTask = state.taskId;
    return () => {
      const last = place.current;
      if (last !== null) readingMemory.write(forTask, last);
      place.current = null;
    };
  }, [state.taskId, readingMemory]);

  // One entry is one reader move (KIN-MOBILE-001.md:80): the reader starts at
  // the conversation's name, not in the writing box, and a streamed append or
  // any other repaint must not move it again (AGENTS.md §11). A split route
  // swapping the conversation in place is a new entry. The view mounts before
  // the read names the conversation (`threadModel.ts:134` carries `title: ""`,
  // so the header speaks the untitled placeholder), so the move waits for the
  // first non-empty title; a read that settles without one (`ready` or
  // `error`) has nothing more to wait for and settles on the placeholder.
  useEffect(() => {
    if (movedFor.current === state.taskId) return;
    const settled = state.status === "ready" || state.status === "error";
    if (state.title.trim() === "" && !settled) return;
    movedFor.current = state.taskId;
    focusNode(titleRef);
  }, [state.taskId, state.title, state.status]);

  // Closing the usage sheet is the person's own way back: the reader returns
  // to the 用量 entry that opened it, once per close (`KIN-MOBILE-001.md:124`).
  // The sheet's `Modal` has already unmounted when this effect runs, so the
  // entry is the only surface left to land on; opening the sheet, mounting
  // with it closed and repainting while it stays closed move nothing
  // (AGENTS.md §11).
  useEffect(() => {
    if (usageWasOpen.current && !usageOpen) focusNode(usageRef);
    usageWasOpen.current = usageOpen;
  }, [usageOpen]);

  const toggleStep = (key: string): void => {
    setExpandedSteps((current) => ({ ...current, [key]: current[key] !== true }));
  };

  const handleScroll = (
    event: NativeSyntheticEvent<NativeScrollEvent>,
  ): void => {
    const { contentOffset, contentSize, layoutMeasurement } = event.nativeEvent;
    const target = restoring.current;
    if (target !== null) {
      // A restore the content has not caught up with yet: this frame is the
      // clamp, not the reader arriving, so it must neither re-pin the follow
      // flag (growth would then jump to the newest segment) nor replace the
      // place with the clamped offset. The restore is settled only when the
      // offset actually reaches it.
      follow.current = { pinned: false };
      if (contentOffset.y >= target) restoring.current = null;
      place.current = { offset: target, pinned: false };
      return;
    }
    follow.current = followOnScroll(follow.current, {
      offset: contentOffset.y,
      contentHeight: contentSize.height,
      viewportHeight: layoutMeasurement.height,
    });
    // The place the reader was last seen at: observed on the frame, stored
    // when the route leaves.
    place.current = { offset: contentOffset.y, pinned: follow.current.pinned };
  };

  const handleContentSize = (_width: number, height: number): void => {
    const previous = lastContentHeight.current;
    lastContentHeight.current = height;
    // The first laid-out content is where a conversation opens at its newest
    // segment; the list arrives here without turns while the read is pending.
    if (openedFor.current !== state.taskId) {
      if (state.turns.length === 0 || height <= 0) return;
      openedFor.current = state.taskId;
      // Where this conversation was left (KIN-MOBILE-001 §3/§4 离开再回来).
      // A place away from the live edge is the reader's, and restoring it must
      // also leave the follow flag unpinned *before* any growth can be folded
      // in, or the next streamed append would pull them back to the end. A
      // place at the edge, or none at all, opens on the newest segment: the
      // content may have grown while they were away, so a stale offset must
      // never beat it for a reader who was following.
      const saved = readingMemory.read(state.taskId);
      if (saved !== null && !saved.pinned) {
        follow.current = { pinned: false };
        restoring.current = saved.offset;
        listRef.current?.scrollToOffset({
          offset: saved.offset,
          animated: false,
        });
        return;
      }
      follow.current = initialFollow();
      listRef.current?.scrollToEnd({ animated: false });
      return;
    }
    // Growth while the reader is away from the end must not move the page.
    if (height <= previous) return;
    const target = restoring.current;
    if (target !== null) {
      // The first layout held only the list's initial window, so the restore
      // clamped short of a deep place. The content that makes it reachable is
      // here now, so move again rather than follow the newest segment.
      listRef.current?.scrollToOffset({ offset: target, animated: false });
      return;
    }
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

  // The spine's thread-level facts (KIN-MOBILE-002 R4b): the live agent turn
  // owns the live tone, an unclean round is red, and a waiting approval
  // outranks the running flag so the blocked turn reads orange.
  const spine: SpineContext = {
    lastAgentIndex: lastAgentTurnIndex(state.turns),
    running: state.running,
    failed: roundEndedUncleanly(state.turns, t("chat.stoppedNote")),
    awaitingApproval:
      approvals !== undefined &&
      approvals.state.items.some((item) => item.pending),
    stoppedNote: t("chat.stoppedNote"),
  };

  // An open round that has not spoken yet ends the transcript with one working
  // line (signed §4 慢: keep what arrived and show the activity row). The shared
  // predicate is the web console's own, so the two surfaces agree on when a
  // round is silent; the gate keeps the first load's skeleton the only cue
  // (TASTE 15) and a settled conversation free of the line.
  const showThinking =
    state.status === "ready" &&
    state.turns.length > 0 &&
    shouldShowGenericThinking(transcriptItems(state.turns), state.running);

  // A settled conversation that the agent never answered takes the same spot
  // as the thinking row, never both: one cue per moment (TASTE 15). The
  // predicate is module scope so its running guard can be pinned directly —
  // the footer checks the thinking row first, which would hide that guard
  // from the rendered tree.
  const showNoAnswer = shouldShowNoAnswer(state);

  // The list header keeps the read's notices above the turns and outside the
  // virtualized cells, so a repaint of the transcript cannot unmount them.
  const listHeader = (
    <>
      {/* The bar is lifted out of the flow, so the transcript's first content
          reserves its full height: at rest the first turn opens below the
          glass, never under it. Decoration only, so no reader stops here. */}
      <View
        accessibilityElementsHidden
        importantForAccessibility="no-hide-descendants"
        style={{ height: headerTotalHeight(insets.top) }}
        testID="conversation:header-spacer"
      />
      {state.status === "loading" && state.turns.length === 0 ? (
        // Nothing read yet: the message area's shape, not a lone caption.
        <ConversationSkeleton t={t} />
      ) : null}
      {state.status === "loading" && state.turns.length > 0 ? (
        // A refresh with turns already read keeps them and adds the hint only
        // (TASTE 15).
        <Text style={styles.notice}>{t("common.loading")}</Text>
      ) : null}
      {state.status === "error" ? (
        <View style={styles.failed}>
          <Text accessibilityRole="alert" style={styles.failure}>
            {t(reasonKey(state.reason))}
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
    </>
  );
  // DESIGN.md:47 — a pending 批准 already owns the screen's one filled
  // primary, so Send must not paint a second one. The prop is optional.
  const primaryTaken = (approvals?.state.pendingCount ?? 0) > 0;
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
        style={[
          styles.header,
          glass.kind === "blur" ? styles.headerGlass : styles.headerOpaque,
          { paddingTop: headerTopInset(insets.top) },
        ]}
        testID="conversation:header"
      >
        {/*
          The surface behind the row, not a cover over it: the header's own
          background stays transparent while the blur shows, so the transcript
          passing underneath tints the chrome.
        */}
        <GlassSurface style={StyleSheet.absoluteFill} />
        <Pressable
          accessibilityLabel={t("app.back")}
          accessibilityRole="button"
          onPress={onBack}
          style={styles.back}
          testID="conversation:back"
        >
          <Text style={styles.backText}>{t("app.back")}</Text>
        </Pressable>
        {/* The conversation's name, spoken as the screen's heading. It is
            text, not a control: the row already has its back and usage
            targets. One line, so a long name truncates rather than growing
            the header. */}
        <Text
          accessibilityRole="header"
          numberOfLines={1}
          ref={titleRef}
          style={styles.title}
          testID="conversation:title"
        >
          {state.title.trim() === "" ? t("sessions.untitled") : state.title}
        </Text>
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
            ref={usageRef}
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
        // At the end of the content, so it scrolls with the transcript and can
        // never cover the composer below. One polite line, never a control;
        // one branch, so the thinking row and the no-answer line cannot both
        // claim this moment.
        ListFooterComponent={
          showThinking ? (
            <Text
              accessibilityLabel={t("chat.thinking")}
              accessibilityLiveRegion="polite"
              style={styles.notice}
              testID="conversation:thinking"
            >
              {t("chat.thinking")}
            </Text>
          ) : showNoAnswer ? (
            <Text
              accessibilityLabel={t("chat.noAnswer")}
              style={styles.notice}
              accessibilityLiveRegion="polite"
              testID="conversation:no-answer"
            >
              {t("chat.noAnswer")}
            </Text>
          ) : undefined
        }
        onContentSizeChange={handleContentSize}
        onScroll={handleScroll}
        // A reader who starts scrolling while the content is still arriving
        // has chosen a new place: stop restoring rather than fight them
        // (`ui/src/components/mobile/MobileList.tsx:105-107`).
        onScrollBeginDrag={() => {
          restoring.current = null;
        }}
        ref={listRef}
        renderItem={({ item, index }) => (
          <TurnBlock
            expandedSteps={expandedSteps}
            index={index}
            onToggleStep={toggleStep}
            spine={spine}
            t={t}
            turn={item}
          />
        )}
        scrollEventThrottle={16}
        style={styles.scroller}
        testID="conversation:turns"
      />
      {showApprovals && approvals ? (
        // What the next turn waits on stays in reach at every scroll position,
        // docked above the composer the way the composer is docked above the
        // home indicator (TASTE §18, DESIGN.md:39). Outside the `onSend`
        // guard: a thread that failed to load has no composer, and the card
        // that blocks the turn must still be here.
        <View
          // With no composer below it, the dock is the last child and owns
          // the home-indicator clearance itself; with one, the composer dock
          // already carries it and the band keeps only its 8pt of air.
          style={[
            styles.approvalDock,
            onSend
              ? null
              : { paddingBottom: composerBottomInset(insets.bottom) },
          ]}
          testID="conversation:approvalDock"
        >
          <ApprovalsSection {...approvals} embedded />
        </View>
      ) : null}
      {onSend ? (
        // A sibling of the scroller, not a row inside it: the composer is
        // reachable at every scroll position. The dock owns the home-indicator
        // clearance, so the capsule itself floats 8pt above it (DESIGN.md:39).
        <View
          style={{ paddingBottom: composerBottomInset(insets.bottom) }}
          testID="conversation:composerDock"
        >
          <Composer
            draftMemory={draftMemory}
            onSend={onSend}
            onStop={onStop}
            onWithdraw={onWithdraw}
            primaryTaken={primaryTaken}
            state={state}
            t={t}
          />
        </View>
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

const makeStyles = (
  colors: Palette,
  glassColor: string = "transparent",
) => StyleSheet.create({
  /**
   * The docked approval band: the capsule's inset, no colours of its own. The
   * cards already carry their own surface, and three pending cards may take
   * more of the screen — the turn is blocked, so the room is theirs.
   */
  approvalDock: {
    gap: 12,
    marginHorizontal: 16,
    marginBottom: 8,
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
    color: colors.blueInk,
    fontSize: 16,
    fontWeight: "600",
  },
  body: {
    gap: 12,
    padding: 16,
    paddingBottom: 48,
  },
  /**
   * The person's own message (KIN-MOBILE-002 R4b): a right-aligned bubble in
   * the scheme's bubble blue, on-brand ink. `maxWidth` leaves the other side
   * readable and still wraps a long word rather than clipping it at 390.
   */
  bubble: {
    alignSelf: "flex-end",
    backgroundColor: colors.bubbleUser,
    borderRadius: radius.bubble,
    marginTop: 8,
    maxWidth: "82%",
    paddingHorizontal: 14,
    paddingVertical: 10,
  },
  bubbleText: {
    color: colors.onBrand,
    fontSize: 16,
    fontWeight: "600",
  },
  /**
   * The composer's one round control (DESIGN.md:39): a 44pt target whose
   * square box plus half-side radius is the circle. Send and Stop share it;
   * fill, border and ink are the small differences that name each one.
   */
  circle: {
    alignItems: "center",
    backgroundColor: "transparent",
    borderRadius: radius.composer,
    height: BACK_SIZE,
    justifyContent: "center",
    // The fixed box is the circle; the floors keep a font scale or a
    // platform that ignores the size from shrinking the target below 44pt.
    minHeight: BACK_SIZE,
    minWidth: BACK_SIZE,
    width: BACK_SIZE,
  },
  /** Closed: the same circle at reduced presence, not a different shape. */
  circleDisabled: {
    opacity: 0.5,
  },
  /** A draft exists and no 批准 is waiting: Send is the filled primary. */
  circleFilled: {
    backgroundColor: colors.blue,
  },
  circleLabel: {
    color: colors.blueInk,
    fontSize: 13,
    fontWeight: "600",
  },
  circleLabelFilled: {
    color: colors.onBrand,
  },
  // The sending control's word keeps the box it always had, so the cue
  // replacing it cannot move the circle; the platform indicator covers it.
  circleLabelHidden: {
    opacity: 0,
  },
  /** Stop is the outlined circle: the hairline is its whole edge. */
  stopCircle: {
    borderColor: colors.hairlineStrong,
    borderWidth: StyleSheet.hairlineWidth,
  },
  stopCircleLabel: {
    color: colors.redInk,
  },
  composer: {
    borderColor: colors.hairlineStrong,
    borderRadius: radius.composer,
    borderWidth: StyleSheet.hairlineWidth,
    overflow: "hidden",
    marginHorizontal: 16,
    marginBottom: 8,
    paddingHorizontal: 16,
    paddingVertical: 12,
    backgroundColor: "transparent",
    gap: 8,
  },
  composerRow: {
    alignItems: "flex-end",
    flexDirection: "row",
    gap: 8,
  },
  container: {
    backgroundColor: colors.bg,
    flex: 1,
  },
  detailLabel: {
    color: colors.muted,
    fontSize: 12,
    fontWeight: "600",
  },
  detailText: {
    color: colors.secondary,
    fontFamily: MONO,
    fontSize: 13,
  },
  errorItem: {
    color: colors.redInk,
    fontSize: 15,
  },
  failed: {
    gap: 8,
  },
  failure: {
    color: colors.redInk,
    fontSize: 15,
  },
  /**
   * Chrome, not a panel in the flow: the bar floats over the transcript so the
   * content scrolls beneath it, and the hairline is the same line the composer
   * draws at the bottom. Its colour belongs to the glass branch below, so the
   * blur is never covered by a bar paint.
   */
  header: {
    alignItems: "center",
    borderBottomColor: colors.hairlineStrong,
    borderBottomWidth: StyleSheet.hairlineWidth,
    flexDirection: "row",
    gap: 8,
    left: 0,
    minHeight: HEADER_ROW_HEIGHT,
    paddingHorizontal: 4,
    position: "absolute",
    right: 0,
    top: 0,
    zIndex: 1,
  },
  /** The blur branch: the transcript behind the bar is what paints it. */
  headerGlass: {
    backgroundColor: "transparent",
  },
  /** Reduced transparency / Android: today's opaque bar, unchanged. */
  headerOpaque: {
    backgroundColor: glassColor,
  },
  input: {
    borderColor: colors.hairlineStrong,
    borderRadius: 8,
    borderWidth: 1,
    color: colors.text,
    flex: 1,
    fontSize: 16,
    maxHeight: 120,
    minHeight: BACK_SIZE,
    paddingHorizontal: 12,
    paddingVertical: 10,
  },
  item: {
    color: colors.text,
    fontSize: 16,
  },
  note: {
    color: colors.secondary,
    fontSize: 14,
    fontStyle: "italic",
  },
  notice: {
    color: colors.secondary,
    fontSize: 15,
  },
  progress: {
    borderLeftColor: colors.hairlineStrong,
    borderLeftWidth: 2,
    gap: 4,
    paddingLeft: 12,
  },
  queue: {
    gap: 6,
  },
  queueLabel: {
    color: colors.muted,
    fontSize: 12,
    fontWeight: "600",
  },
  queueRow: {
    alignItems: "center",
    flexDirection: "row",
    gap: 8,
  },
  queueText: {
    color: colors.text,
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
    color: colors.blueInk,
    fontSize: 15,
    fontWeight: "600",
  },
  running: {
    color: colors.muted,
    fontSize: 13,
    fontWeight: "600",
  },
  scroller: {
    flex: 1,
  },
  sendingCue: {
    alignItems: "center",
    justifyContent: "center",
  },
  /** The activity spine (DESIGN.md 活动脊): 3pt edge, 8pt gap to the text. */
  spineApproval: {
    borderLeftColor: colors.orange,
    borderLeftWidth: 3,
    paddingLeft: 8,
  },
  spineDone: {
    borderLeftColor: colors.green,
    borderLeftWidth: 3,
    paddingLeft: 8,
  },
  spineFailed: {
    borderLeftColor: colors.red,
    borderLeftWidth: 3,
    paddingLeft: 8,
  },
  spineRunning: {
    borderLeftColor: colors.blue,
    borderLeftWidth: 3,
    paddingLeft: 8,
  },
  tool: {
    color: colors.secondary,
    flexShrink: 1,
    fontFamily: MONO,
    fontSize: 13,
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
    borderColor: colors.hairlineStrong,
    borderRadius: 8,
    borderWidth: StyleSheet.hairlineWidth,
    gap: 2,
    justifyContent: "center",
    minHeight: BACK_SIZE,
    paddingHorizontal: 10,
    paddingVertical: 8,
  },
  toolStatus: {
    color: colors.muted,
    fontFamily: MONO,
    fontSize: 12,
    fontWeight: "600",
  },
  toolToggle: {
    color: colors.blueInk,
    fontSize: 12,
    fontWeight: "600",
    marginLeft: "auto",
  },
  // The header's one flexible cell: it takes the space between the back
  // control and the trailing status/usage entries, and truncates on one line.
  title: {
    color: colors.text,
    flex: 1,
    fontSize: 17,
    fontWeight: "600",
  },
  turn: {
    gap: 8,
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
    color: colors.blueInk,
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
    color: colors.blueInk,
    fontSize: 13,
    fontWeight: "600",
  },
});
