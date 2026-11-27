/**
 * KIN-MOBILE-001 R5b — the approvals and questions screen, phone presentation.
 *
 * Pure: it renders the view state the R5 model produced and calls back with
 * the ids and the chosen option. Reads, transitions, bounds and stale-answer
 * drops stay in `approvalsModel.ts`; this file owns only the cards, the four
 * non-ready states, and the mapping from stable codes to the shared i18n
 * catalogue (the model deliberately carries no sentences).
 *
 * Every action is one ≥44pt control with a reader label naming both the verb
 * and its object (TASTE 11), and a settled card announces its result once
 * through the single polite live region (AGENTS.md §11: the list that asked
 * owns the answer, so nothing here keeps its own copy of an item).
 *
 * This file draws no route: the standalone screen and the conversation's
 * embedded section are the same body, so one card never reads two ways.
 */

import { useEffect, useMemo, useRef, useState } from "react";
import type { RefObject } from "react";
import * as Haptics from "expo-haptics";
import {
  Pressable,
  ScrollView,
  StyleSheet,
  Text,
  View,
  type ViewInstance,
} from "react-native";
import { focusNode } from "../a11y/focus";
import { useTheme } from "../theme/useTheme";
import { radius, wash, type Palette } from "../theme/tokens";
import type {
  ApprovalEntry,
  ApprovalsState,
  EntryFailure,
  PendingEntry,
  QuestionEntry,
} from "../approvals/approvalsModel";

type Translate = (
  key: string,
  params?: Record<string, string | number>,
) => string;

export type ApprovalsScreenProps = {
  state: ApprovalsState;
  t: Translate;
  onApprove: (id: string) => void;
  onDeny: (id: string) => void;
  onAnswer: (id: string, text: string) => void;
  /** A failed card's retry; the card offers it only when this is passed. */
  onRetry?: (id: string) => void;
  onRefresh?: () => void;
};

/**
 * Whether an entry may send an answer now: it must still be idle and the phone
 * must be online. A failure restores `idle`, so a failed card becomes operable
 * again; a handled one (`resolved`) never does.
 */
export function entryActionable(entry: PendingEntry, online: boolean): boolean {
  return online && entry.phase === "idle";
}

/**
 * Move the reader once, on the transition into a settled state within this
 * mount. The ref remembers the previous value across renders, so a card that
 * arrives already handled after a reload takes no focus: the list that asked
 * owns that answer (AGENTS.md §11). A submit in flight changes neither target,
 * so the pressed control keeps the reader where it is.
 */
function useReaderFocus(
  target: boolean,
  ref: RefObject<ViewInstance | null>,
): void {
  const wasTarget = useRef(target);
  useEffect(() => {
    if (target && !wasTarget.current) focusNode(ref);
    wasTarget.current = target;
  }, [target, ref]);
}

function isRecord(value: unknown): value is Record<string, unknown> {
  return value !== null && typeof value === "object" && !Array.isArray(value);
}

/**
 * Run one haptic without letting it speak. The taptic engine is a device
 * courtesy, not part of the decision: a phone that cannot vibrate (or a jest
 * render with no native module) must not break the card that just landed.
 */
function fireHaptic(call: () => Promise<unknown>): void {
  try {
    void Promise.resolve(call()).catch(() => undefined);
  } catch {
    // No engine, no receipt — the visible result is still the answer.
  }
}

/**
 * KIN-MOBILE-002 R5 — one haptic per approval outcome (DESIGN.md:41):
 * an approved or denied card gives one medium impact plus one success
 * notification as the decision lands, a failed write gives one error
 * notification instead, and nothing is felt on the press itself.
 *
 * The ref of the previous phase is the whole guard: a card that mounts already
 * resolved (a reload, or the list that answered while this screen was away)
 * fires nothing, and a repaint while resolved fires nothing again. Only the
 * transition out of `submitting` is an outcome this card witnessed
 * (AGENTS.md §11: the late answer belongs to the flow that asked).
 */
function useApprovalHaptics(entry: ApprovalEntry): void {
  const previous = useRef(entry.phase);

  useEffect(() => {
    const before = previous.current;
    previous.current = entry.phase;
    if (before !== "submitting") return;

    // A failed write returns to idle with the failure still on the card; that
    // transition, not a resolved card, is where the error receipt belongs.
    if (entry.phase === "idle" && entry.failure) {
      fireHaptic(() =>
        Haptics.notificationAsync(Haptics.NotificationFeedbackType.Error),
      );
      return;
    }
    if (entry.phase !== "resolved") return;

    fireHaptic(() => Haptics.impactAsync(Haptics.ImpactFeedbackStyle.Medium));
    fireHaptic(() =>
      Haptics.notificationAsync(Haptics.NotificationFeedbackType.Success),
    );
  }, [entry.phase, entry.failure]);
}

/** The tool and the body of the permission being asked for. */
function approvalView(payload: unknown): {
  toolName: string;
  detail: string;
} {
  const record = isRecord(payload) ? payload : {};
  const toolName = typeof record.tool_name === "string" ? record.tool_name : "";
  const input = isRecord(record.input) ? record.input : {};
  const command =
    typeof input.command === "string"
      ? input.command
      : typeof input.cmd === "string"
        ? input.cmd
        : typeof input.file_path === "string"
          ? input.file_path
          : "";
  const detail =
    command ||
    (Object.keys(input).length > 0
      ? (JSON.stringify(input, null, 2) ?? "")
      : "");
  return { toolName, detail };
}

/** The catalogue sentence for a transport reason (never a raw code). */
function failureKey(failure: EntryFailure): string {
  switch (failure.reason) {
    case "expired":
      return "pairing.expired";
    case "rejected":
      return "pairing.rejected";
    default:
      return "pairing.unreachable";
  }
}

function decidedApproval(entry: ApprovalEntry): ApprovalEntry["approval"]["decision"] {
  return entry.resolution?.kind === "approval"
    ? entry.resolution.decision
    : entry.approval.decision;
}

function approvalTitle(entry: ApprovalEntry, t: Translate): string {
  switch (decidedApproval(entry)) {
    case "approved":
      return t("approval.approvedTitle");
    case "denied":
      return t("approval.deniedTitle");
    case "expired":
      return t("approval.expiredTitle");
    default:
      return t("approval.cardTitle");
  }
}

function FailureRow({
  failure,
  id,
  t,
  onRetry,
  containerRef,
}: {
  failure: EntryFailure;
  id: string;
  t: Translate;
  onRetry?: (id: string) => void;
  /** The card keeps the ref so only a fresh failure, not a reload, focuses. */
  containerRef?: RefObject<ViewInstance | null>;
}) {
  const { colors } = useTheme();
  const styles = useMemo(() => makeStyles(colors), [colors]);
  return (
    <View style={styles.failureRow}>
      {/* The reason is one alert stop; the retry stays its sibling, because an
          `accessible` group would collapse the control out of the reader. */}
      <View
        accessible
        accessibilityRole="alert"
        ref={containerRef}
        style={styles.failureReason}
        testID={`failure:${id}`}
      >
        <Text accessibilityRole="alert" style={styles.failureText}>
          {t("inbox.decisionFailed")}
        </Text>
        <Text style={styles.failureText}>{t(failureKey(failure))}</Text>
      </View>
      {onRetry ? (
        <Pressable
          accessibilityRole="button"
          onPress={() => onRetry(id)}
          style={styles.action}
          testID={`retry:${id}`}
        >
          <Text style={styles.actionText}>{t("pairing.retry")}</Text>
        </Pressable>
      ) : null}
    </View>
  );
}

function ApprovalCard({
  entry,
  online,
  t,
  onApprove,
  onDeny,
  onRetry,
}: {
  entry: ApprovalEntry;
  online: boolean;
  t: Translate;
  onApprove: (id: string) => void;
  onDeny: (id: string) => void;
  onRetry?: (id: string) => void;
}) {
  const { toolName, detail } = approvalView(entry.approval.payload);
  const { colors } = useTheme();
  const styles = useMemo(() => makeStyles(colors), [colors]);
  const resolved = entry.phase === "resolved";
  const submitting = entry.phase === "submitting";
  const actionable = entryActionable(entry, online);
  const title = resolved ? approvalTitle(entry, t) : t("approval.cardTitle");
  const object = toolName || t("approval.cardTitle");
  const resultRef = useRef<ViewInstance | null>(null);
  const failureRef = useRef<ViewInstance | null>(null);
  useReaderFocus(resolved, resultRef);
  useReaderFocus(entry.failure != null, failureRef);
  useApprovalHaptics(entry);

  return (
    <View style={styles.card} testID={`card:${entry.key}`}>
      <Text accessibilityRole="header" style={styles.cardTitle}>
        {title}
      </Text>
      <View style={styles.request}>
        <Text style={styles.tool}>{object}</Text>
        {detail ? <Text style={styles.detail}>{detail}</Text> : null}
      </View>

      {entry.failure ? (
        <FailureRow
          containerRef={failureRef}
          failure={entry.failure}
          id={entry.id}
          onRetry={onRetry}
          t={t}
        />
      ) : null}

      {resolved ? (
        <View
          accessible
          accessibilityLabel={`${title} · ${object}`}
          accessibilityRole="text"
          ref={resultRef}
          style={styles.result}
          testID={`result:${entry.key}`}
        >
          {/* One polite announcement per settled card; the title stays quiet. */}
          <Text accessibilityLiveRegion="polite" style={styles.resultText}>
            {t("approval.decidedFallback")}
          </Text>
        </View>
      ) : null}

      <View style={styles.actionRow}>
        <Pressable
          accessibilityLabel={
            submitting
              ? `${t("approval.approving")} · ${object}`
              : `${t("approval.approvedTitle")} · ${object}`
          }
          accessibilityRole="button"
          accessibilityState={{ disabled: !actionable }}
          disabled={!actionable}
          onPress={() => onApprove(entry.id)}
          style={[styles.action, styles.approve, !actionable && styles.actionDim]}
          testID={`approve:${entry.id}`}
        >
          <Text style={[styles.actionText, styles.approveLabel]}>
            {submitting ? t("approval.approving") : t("chat.approve")}
          </Text>
        </Pressable>
        <Pressable
          accessibilityLabel={
            submitting
              ? `${t("approval.denying")} · ${object}`
              : `${t("approval.deniedTitle")} · ${object}`
          }
          accessibilityRole="button"
          accessibilityState={{ disabled: !actionable }}
          disabled={!actionable}
          onPress={() => onDeny(entry.id)}
          style={[styles.action, styles.deny, !actionable && styles.actionDim]}
          testID={`deny:${entry.id}`}
        >
          <Text style={[styles.actionText, styles.denyLabel]}>
            {submitting ? t("approval.denying") : t("chat.deny")}
          </Text>
        </Pressable>
      </View>
    </View>
  );
}

function QuestionCard({
  entry,
  online,
  t,
  chosen,
  onChoose,
  onAnswer,
  onRetry,
}: {
  entry: QuestionEntry;
  online: boolean;
  t: Translate;
  chosen: string | null;
  onChoose: (key: string, option: string) => void;
  onAnswer: (id: string, text: string) => void;
  onRetry?: (id: string) => void;
}) {
  const { colors } = useTheme();
  const styles = useMemo(() => makeStyles(colors), [colors]);
  const payload = entry.question.payload;
  const prompt = payload.question?.trim()
    ? payload.question
    : t("question.fallback");
  const options = Array.isArray(payload.options) ? payload.options : [];
  const resolved = entry.phase === "resolved";
  const submitting = entry.phase === "submitting";
  const canSubmit = entryActionable(entry, online) && chosen !== null;
  const result =
    entry.resolution?.kind === "question" ? entry.resolution.text : prompt;
  const resultRef = useRef<ViewInstance | null>(null);
  const failureRef = useRef<ViewInstance | null>(null);
  useReaderFocus(resolved, resultRef);
  useReaderFocus(entry.failure != null, failureRef);

  return (
    <View style={styles.card} testID={`card:${entry.key}`}>
      <Text accessibilityRole="header" style={styles.cardTitle}>
        {t("question.cardTitle")}
      </Text>
      <Text style={styles.prompt}>{prompt}</Text>

      {entry.failure ? (
        <FailureRow
          containerRef={failureRef}
          failure={entry.failure}
          id={entry.id}
          onRetry={onRetry}
          t={t}
        />
      ) : null}

      {resolved ? (
        <View
          accessible
          accessibilityLabel={`${prompt} · ${result}`}
          accessibilityRole="text"
          ref={resultRef}
          style={styles.result}
          testID={`result:${entry.key}`}
        >
          <Text accessibilityLiveRegion="polite" style={styles.resultText}>
            {result}
          </Text>
        </View>
      ) : (
        <>
          <View style={styles.options}>
            {options.map((option, index) => {
              const selected = chosen === option.label;
              return (
                <Pressable
                  accessibilityLabel={
                    option.description
                      ? `${option.label} · ${option.description}`
                      : option.label
                  }
                  accessibilityRole="button"
                  accessibilityState={{
                    disabled: submitting,
                    selected,
                  }}
                  disabled={submitting}
                  key={`${entry.key}:${index}`}
                  onPress={() => onChoose(entry.key, option.label)}
                  style={[
                    styles.action,
                    styles.option,
                    selected && styles.optionSelected,
                  ]}
                  testID={`option:${entry.id}:${index}`}
                >
                  <Text style={styles.optionLabel}>{option.label}</Text>
                  {option.description ? (
                    <Text style={styles.optionDescription}>
                      {option.description}
                    </Text>
                  ) : null}
                </Pressable>
              );
            })}
          </View>
          <Pressable
            accessibilityLabel={`${t("question.submit")} · ${prompt}`}
            accessibilityRole="button"
            accessibilityState={{ disabled: !canSubmit }}
            disabled={!canSubmit}
            onPress={() => {
              if (chosen !== null) onAnswer(entry.id, chosen);
            }}
            style={[
              styles.action,
              styles.submit,
              !canSubmit && styles.actionDim,
            ]}
            testID={`submit:${entry.id}`}
          >
            <Text style={styles.actionText}>
              {submitting ? t("question.submitting") : t("question.submit")}
            </Text>
          </Pressable>
        </>
      )}
    </View>
  );
}

export type ApprovalsSectionProps = ApprovalsScreenProps & {
  /**
   * Hosted inside another scroller (the conversation). An embedded section
   * draws no screen title row and no all-clear block — a conversation shows a
   * card only when there is one — and owns no `ScrollView` of its own.
   */
  embedded?: boolean;
};

export function ApprovalsSection({
  state,
  t,
  onApprove,
  onDeny,
  onAnswer,
  onRetry,
  onRefresh,
  embedded = false,
}: ApprovalsSectionProps) {
  const { colors } = useTheme();
  const styles = useMemo(() => makeStyles(colors), [colors]);
  // The chosen option is a draft for the card that asked, held against the
  // revision it was chosen under: a replaced list starts clean (AGENTS.md §11).
  const [choices, setChoices] = useState<
    Record<string, { revision: number; option: string }>
  >({});
  const chosenFor = (entry: QuestionEntry): string | null => {
    const choice = choices[entry.key];
    return choice && choice.revision === state.revision ? choice.option : null;
  };
  const choose = (key: string, option: string): void => {
    setChoices((previous) => ({
      ...previous,
      [key]: { revision: state.revision, option },
    }));
  };

  const approvals = state.items.filter(
    (entry): entry is ApprovalEntry => entry.kind === "approval",
  );
  const questions = state.items.filter(
    (entry): entry is QuestionEntry => entry.kind === "question",
  );
  const countLine =
    state.pendingCount > 0
      ? t("inbox.waiting", { count: state.pendingCount })
      : t("inbox.noneWaiting");
  const empty = state.status === "ready" && state.items.length === 0;

  return (
    <View style={styles.body}>
      {embedded ? null : (
        <View style={styles.header}>
          <Text accessibilityRole="header" style={styles.headerTitle}>
            {t("inbox.title")}
          </Text>
          {state.status === "ready" ? (
            <Text style={styles.badge}>{countLine}</Text>
          ) : null}
        </View>
      )}

      {state.status === "loading" ? (
        <Text style={styles.status}>{t("inbox.loading")}</Text>
      ) : null}

      {state.status === "error" ? (
        <View style={styles.banner}>
          <Text accessibilityRole="alert" style={styles.bannerText}>
            {t("inbox.loadFailed")}
          </Text>
          {state.error ? (
            <Text style={styles.bannerText}>{t(failureKey(state.error))}</Text>
          ) : null}
          {onRefresh ? (
            <Pressable
              accessibilityRole="button"
              onPress={onRefresh}
              style={styles.action}
              testID="refresh"
            >
              <Text style={styles.actionText}>{t("pairing.retry")}</Text>
            </Pressable>
          ) : null}
        </View>
      ) : null}

      {!state.online ? (
        <View style={styles.banner}>
          <Text accessibilityRole="alert" style={styles.bannerText}>
            {t("pairing.unreachable")}
          </Text>
        </View>
      ) : null}

      {!embedded && empty ? (
        <View style={styles.empty}>
          <Text style={styles.emptyTitle}>{t("inbox.allClear")}</Text>
          <Text style={styles.emptyHint}>{t("inbox.allClearHint")}</Text>
        </View>
      ) : null}

      {approvals.length > 0 ? (
        <Text accessibilityRole="header" style={styles.section}>
          {t("inbox.approvalsSection")}
        </Text>
      ) : null}
      {approvals.map((entry) => (
        <ApprovalCard
          entry={entry}
          key={entry.key}
          onApprove={onApprove}
          onDeny={onDeny}
          onRetry={onRetry}
          online={state.online}
          t={t}
        />
      ))}

      {questions.length > 0 ? (
        <Text accessibilityRole="header" style={styles.section}>
          {t("inbox.questionsSection")}
        </Text>
      ) : null}
      {questions.map((entry) => (
        <QuestionCard
          chosen={chosenFor(entry)}
          entry={entry}
          key={entry.key}
          onAnswer={onAnswer}
          onChoose={choose}
          onRetry={onRetry}
          online={state.online}
          t={t}
        />
      ))}
    </View>
  );
}

/**
 * The standalone screen: the same section, owning the page's one scroller.
 * The conversation mounts `ApprovalsSection` directly inside its own scroller,
 * so the phone never nests two vertical `ScrollView`s.
 */
export default function Approvals(props: ApprovalsScreenProps) {
  const { colors } = useTheme();
  const styles = useMemo(() => makeStyles(colors), [colors]);
  return (
    <ScrollView
      contentContainerStyle={styles.content}
      style={styles.screen}
      testID="approvals-screen"
    >
      <ApprovalsSection {...props} />
    </ScrollView>
  );
}

const makeStyles = (colors: Palette) => StyleSheet.create({
  /** Every action, option and retry is one ≥44pt target (TASTE 11). */
  action: {
    alignItems: "center",
    borderRadius: 8,
    justifyContent: "center",
    minHeight: 44,
    minWidth: 44,
    paddingHorizontal: 12,
    paddingVertical: 8,
  },
  actionDim: {
    opacity: 0.5,
  },
  actionRow: {
    flexDirection: "row",
    gap: 8,
  },
  actionText: {
    color: colors.blueInk,
    fontSize: 15,
    fontWeight: "600",
  },
  /**
   * 批准 is the card's one filled control: the brand pigment with the ink
   * `theme.css` assigns to it, at the frame's button radius. 拒绝 is its
   * outlined counterpart in red ink, so the safe action never reads as the
   * destructive one (KIN-MOBILE-002 R5, the frame's approval card).
   */
  approve: {
    backgroundColor: colors.blue,
    borderRadius: radius.bubble,
  },
  approveLabel: {
    color: colors.onBrand,
  },
  badge: {
    color: colors.orangeInk,
    fontSize: 13,
    fontWeight: "600",
  },
  banner: {
    alignItems: "center",
    backgroundColor: wash(colors.orange, 0.15),
    borderRadius: 8,
    flexDirection: "row",
    flexWrap: "wrap",
    gap: 8,
    minHeight: 44,
    paddingHorizontal: 12,
    paddingVertical: 8,
  },
  bannerText: {
    color: colors.orangeInk,
    flexShrink: 1,
    fontSize: 14,
  },
  body: {
    gap: 12,
  },
  card: {
    backgroundColor: colors.elevated,
    borderColor: colors.hairlineStrong,
    borderRadius: radius.card,
    borderWidth: 1,
    gap: 8,
    padding: 12,
  },
  cardTitle: {
    color: colors.text,
    fontSize: 16,
    fontWeight: "600",
  },
  content: {
    gap: 12,
    padding: 16,
    paddingBottom: 32,
  },
  deny: {
    backgroundColor: "transparent",
    borderColor: colors.hairlineStrong,
    borderWidth: 1,
  },
  denyLabel: {
    color: colors.redInk,
  },
  detail: {
    color: colors.secondary,
    fontFamily: "monospace",
    fontSize: 13,
  },
  empty: {
    alignItems: "center",
    gap: 8,
    padding: 24,
  },
  emptyHint: {
    color: colors.muted,
    fontSize: 14,
    textAlign: "center",
  },
  emptyTitle: {
    color: colors.text,
    fontSize: 16,
    fontWeight: "600",
  },
  failureReason: {
    alignItems: "center",
    flexDirection: "row",
    flexShrink: 1,
    flexWrap: "wrap",
    gap: 8,
  },
  failureRow: {
    alignItems: "center",
    flexDirection: "row",
    flexWrap: "wrap",
    gap: 8,
  },
  failureText: {
    color: colors.redInk,
    fontSize: 13,
  },
  header: {
    alignItems: "center",
    flexDirection: "row",
    gap: 12,
    justifyContent: "space-between",
    minHeight: 44,
  },
  headerTitle: {
    color: colors.text,
    fontSize: 20,
    fontWeight: "700",
  },
  option: {
    alignItems: "flex-start",
    borderColor: colors.hairlineStrong,
    borderWidth: 1,
  },
  optionDescription: {
    color: colors.muted,
    fontSize: 13,
  },
  optionLabel: {
    color: colors.text,
    fontSize: 15,
  },
  optionSelected: {
    backgroundColor: wash(colors.blue, 0.12),
    borderColor: colors.focusRing,
  },
  options: {
    gap: 8,
  },
  prompt: {
    color: colors.secondary,
    fontSize: 14,
  },
  request: {
    gap: 4,
  },
  result: {
    backgroundColor: colors.fill,
    borderRadius: 8,
    paddingHorizontal: 12,
    paddingVertical: 8,
  },
  resultText: {
    color: colors.secondary,
    fontSize: 14,
  },
  screen: {
    backgroundColor: colors.bg,
    flex: 1,
  },
  section: {
    color: colors.secondary,
    fontSize: 13,
    fontWeight: "700",
    letterSpacing: 0.6,
    textTransform: "uppercase",
  },
  status: {
    color: colors.muted,
    fontSize: 14,
  },
  submit: {
    alignSelf: "flex-start",
  },
  tool: {
    color: colors.text,
    fontSize: 15,
    fontWeight: "600",
  },
});
