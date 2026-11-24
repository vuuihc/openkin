/**
 * KIN-MOBILE-001 R4b — the phone's read-only conversation, phone presentation.
 *
 * Pure: it draws the view state `threadModel` produced and nothing else. No
 * fetch, no router, no storage — and no composer, send box or stop row. This
 * slice is history; their absence is the honest state until the live round
 * lands. The pending approvals and questions of *this* task may mount above
 * the transcript through `approvals`, already scoped by the container.
 *
 * The turn shapes are the shared projection's (`ChatItem`, `Turn` from
 * `ui/src/components/chat/transcriptProjection.ts`), so the phone cannot
 * disagree with the web console about what belongs to a turn.
 */

import { Pressable, ScrollView, StyleSheet, Text, View } from "react-native";
import type {
  ChatItem,
  Turn,
} from "../../../ui/src/components/chat/transcriptProjection";
import type { ThreadState } from "../thread/threadModel";
import {
  ApprovalsSection,
  type ApprovalsScreenProps,
} from "./Approvals";

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

export default function ConversationView({
  state,
  t,
  onBack,
  onRetry,
  approvals,
}: ConversationViewProps) {
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
      </View>
      <ScrollView contentContainerStyle={styles.body}>
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
    </View>
  );
}

const styles = StyleSheet.create({
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
});
