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

import { useState } from "react";
import {
  Pressable,
  ScrollView,
  StyleSheet,
  Text,
  TextInput,
  View,
} from "react-native";
import type {
  ChatItem,
  Turn,
} from "../../../ui/src/components/chat/transcriptProjection";
import type {
  ProvidersView,
  UsageWindowDays,
} from "../providers/providersModel";
import type { ThreadState } from "../thread/threadModel";
import {
  ApprovalsSection,
  type ApprovalsScreenProps,
} from "./Approvals";
import ProviderUsageSheet from "./ProviderUsageSheet";

/** The signed touch floor; every control on this screen meets it. */
export const BACK_SIZE = 44;

export type ConversationViewProps = {
  state: ThreadState;
  t: (key: string, params?: Record<string, string | number>) => string;
  onBack: () => void;
  /** The failed read's retry; absent when there is nothing to retry. */
  onRetry?: () => void;
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

/** One compact row per step: a note says its text, a tool says its name. */
function ProgressRows({ item }: { item: ProgressItem }) {
  return (
    <View style={styles.progress}>
      {item.steps.map((step) => (
        <Text
          key={step.key}
          numberOfLines={2}
          style={step.kind === "tool" ? styles.tool : styles.note}
        >
          {step.kind === "note" ? step.text : step.name}
        </Text>
      ))}
    </View>
  );
}

function TurnBlock({ turn, index }: { turn: Turn; index: number }) {
  if (turn.kind === "user") {
    return <Text style={styles.user}>{turn.item.text}</Text>;
  }
  const items: ChatItem[] = turn.kind === "agent" ? turn.items : [turn.item];
  return (
    <View style={styles.turn}>
      {items.map((item) =>
        item.kind === "progress" ? (
          <ProgressRows item={item} key={`${index}:${item.key}`} />
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
};

/**
 * The draft is this component's own state and is tagged with the task it was
 * typed for: a screen that swapped conversations draws an empty box, so the
 * old words can neither return nor be posted under the new task (AGENTS.md
 * §11). A failed read, a stream event or a queued send repaints the view
 * without touching this state — that is what "offline keeps the draft" means.
 */
function Composer({ state, t, onSend, onStop, onWithdraw }: ComposerProps) {
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
    <View style={styles.composer}>
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
  approvals,
  onSend,
  onStop,
  onWithdraw,
  usage,
}: ConversationViewProps) {
  // Whether the sheet is up is the person's own transient UI, so it lives in
  // this view; the window choice and the rows are the model's (AGENTS.md §11).
  const [usageOpen, setUsageOpen] = useState(false);
  // A conversation draws no approval chrome when there is nothing to say: no
  // card and no empty state, exactly as an unblocked turn reads today.
  const showApprovals =
    approvals !== undefined &&
    (approvals.state.items.length > 0 ||
      approvals.state.status === "loading" ||
      approvals.state.status === "error" ||
      !approvals.state.online);
  return (
    <View style={styles.container}>
      <View style={styles.header}>
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
      <ScrollView contentContainerStyle={styles.body} style={styles.scroller}>
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
          <Text accessibilityRole="alert" style={styles.notice}>
            {t("pairing.unreachable")}
          </Text>
        ) : null}
        {showApprovals && approvals ? (
          // Above the turns: this is what the next turn is waiting on. The
          // section is scroller-free, so it lives in this one ScrollView.
          <ApprovalsSection {...approvals} embedded />
        ) : null}
        {state.turns.map((turn, index) => (
          <TurnBlock index={index} key={index} turn={turn} />
        ))}
      </ScrollView>
      {onSend ? (
        // A sibling of the scroller, not a row inside it: the composer is
        // reachable at every scroll position.
        <Composer
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
    </View>
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
    paddingBottom: 24,
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
    paddingTop: 48,
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
    fontSize: 14,
    fontWeight: "500",
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
