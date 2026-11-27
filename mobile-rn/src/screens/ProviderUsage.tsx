/**
 * KIN-MOBILE-001 R6 — the provider/usage screen, phone presentation.
 *
 * Pure: it renders the `ProvidersView` the R6 model produced and calls back
 * with the chosen window, a refresh or a close. Reads, the window kept in
 * session memory, the timeout and the late-answer drop stay in
 * `providersModel.ts`; this file owns only the four headline tiles folded by
 * the shared formatter (`ui/src/lib/usage.ts`), the 7/30/90 chips, the
 * read-only provider list and the mapping from stable codes to the shared i18n
 * catalogue (the model deliberately carries no sentences).
 *
 * "Nothing" is two different facts (`providersModel.ts:252-258`): a device with
 * no providers and no rows says "no usage on this device" with its hint, while
 * a configured provider with a quiet window keeps its row and its four tiles
 * read "—", never a zero.
 *
 * Read-only by construction: no provider is activated, edited or deleted here
 * (story §7 "不把 provider 配置的编辑带进 RN"), and the screen keeps no copy of
 * the model's state (AGENTS.md §11).
 *
 * This slice draws no sheet chrome, no route and no container: the bottom
 * sheet and its mount on the conversation header land with a later slice,
 * exactly as R5b's `Approvals` landed before R5c mounted it.
 *
 * KIN-MOBILE-002 R6 adds the signed visual on top of that behaviour: the window
 * switch is one inset segmented control, and a per-agent block sits above the
 * configuration list with an identity dot, a right-aligned tabular amount, a
 * proportional spend bar and a percent + token caption, closed by the window
 * total (`KIN-MOBILE-002.figma/frames/05-phone-usage-sheet.svg`). The rows are
 * the `usageByAgent` fold of `UsageRow.agent`, never provider configuration; the
 * four KIN-MOBILE-001 tiles and every empty/stale/offline/failed state stay.
 */

import { useEffect, useMemo, useRef } from "react";
import {
  Pressable,
  ScrollView,
  StyleSheet,
  Text,
  View,
  type ViewInstance,
} from "react-native";
import {
  cacheRateLabel,
  formatTokenCount,
  summarizeUsage,
} from "../../../ui/src/lib/usage";
import { focusNode } from "../a11y/focus";
import { useTheme } from "../theme/useTheme";
import { tabular, wash, type Palette } from "../theme/tokens";
import {
  USAGE_WINDOWS,
  type ProviderEntry,
  type ProvidersReason,
  type ProvidersView,
  type UsageWindowDays,
} from "../providers/providersModel";
import {
  usageByAgent,
  type AgentUsage,
} from "../usage/usageByAgent";
import UsageSkeleton from "./UsageSkeleton";

type Translate = (
  key: string,
  params?: Record<string, string | number>,
) => string;

export type ProviderUsageScreenProps = {
  state: ProvidersView;
  t: Translate;
  onSelectWindow: (days: UsageWindowDays) => void;
  onRefresh?: () => void;
  onClose?: () => void;
  /**
   * Ask for the reader's focus on the title once, at mount. The sheet passes
   * this while it is visible (`KIN-MOBILE-001.md:124`: the sheet is modal, so
   * focus enters its title); the screen alone never moves the reader.
   */
  autoFocus?: boolean;
};

const WINDOW_LABEL_KEYS: Record<UsageWindowDays, string> = {
  7: "usage.thisWeek",
  30: "usage.days30",
  90: "usage.days90",
};

/** No usage in the window reads as an em dash, never as a zero (usage.ts:35-37). */
const NO_VALUE = "—";

/**
 * `formatCost` from `ui/src/api/client.ts:2832-2836`, kept local because that
 * module carries the browser client and is not importable here (ADR 0036 §2).
 * This is a display rule, not the shared fold: the four numbers themselves
 * come from `summarizeUsage`.
 */
function formatSpend(cost: number): string {
  if (cost < 0.01) return `$${cost.toFixed(4)}`;
  return `$${cost.toFixed(3)}`;
}

/** The catalogue sentence for a transport reason (never a raw code). */
function failureKey(reason: ProvidersReason): string {
  switch (reason) {
    case "expired":
      return "pairing.expired";
    case "rejected":
      return "pairing.rejected";
    default:
      return "pairing.unreachable";
  }
}

/**
 * The agents' identity marks, from `theme/tokens.ts` (never a literal).
 *
 * Matched case-insensitively, and a stored id may carry a suffix
 * (`claude-code`): the mark belongs to the agent family, so a prefix before a
 * hyphen still matches. An agent with no token takes the neutral blue; the dot
 * is decorative and the row's own name and amount carry the meaning.
 */
const IDENTITY_TOKENS: ReadonlyArray<readonly [string, keyof Palette]> = [
  ["claude", "agentClaude"],
  ["codex", "agentCodex"],
  ["droid", "agentDroid"],
  ["workbuddy", "agentWorkbuddy"],
  ["trae", "agentTrae"],
  ["doubao", "agentDoubao"],
  ["zcode", "agentZcode"],
];

function agentColor(colors: Palette, agent: string): string {
  const name = agent.trim().toLowerCase();
  for (const [key, token] of IDENTITY_TOKENS) {
    if (name === key || name.startsWith(`${key}-`)) return colors[token];
  }
  return colors.blue;
}

/**
 * One agent's spend in the window: identity dot, name, amount, proportional
 * bar and the frame's percent + token caption. The bar is the row's share of
 * the window total, rounded to the same whole percent the caption prints.
 */
function AgentRow({
  colors,
  entry,
  styles,
  t,
}: {
  colors: Palette;
  entry: AgentUsage;
  styles: Styles;
  t: Translate;
}) {
  const tint = agentColor(colors, entry.agent);
  const percent = Math.round(entry.share * 100);
  const detail = `${percent}% · ${t("progress.input")} ${formatTokenCount(
    entry.inputTokens,
  )} · ${t("progress.output")} ${formatTokenCount(entry.outputTokens)}`;
  return (
    <View style={styles.agentRow} testID={`usage-agent:${entry.agent}`}>
      <View style={styles.agentHeading}>
        <View
          accessibilityElementsHidden
          importantForAccessibility="no-hide-descendants"
          style={[styles.identityDot, { backgroundColor: tint }]}
          testID={`usage-agent-dot:${entry.agent}`}
        />
        <Text style={styles.agentName}>{entry.agent}</Text>
        <Text style={styles.agentCost}>{formatSpend(entry.cost)}</Text>
      </View>
      <View
        style={styles.agentTrack}
        testID={`usage-agent-track:${entry.agent}`}
      >
        <View
          style={[
            styles.agentBar,
            { backgroundColor: tint, width: `${percent}%` },
          ]}
          testID={`usage-agent-bar:${entry.agent}`}
        />
      </View>
      <Text style={styles.agentDetail}>{detail}</Text>
    </View>
  );
}

function Tile({
  label,
  styles,
  testID,
  value,
}: {
  label: string;
  styles: Styles;
  testID: string;
  value: string;
}) {
  return (
    <View style={styles.tile} testID={`tile:${testID}`}>
      <Text style={styles.tileLabel}>{label}</Text>
      <Text style={styles.tileValue}>{value}</Text>
    </View>
  );
}

function ProviderRow({
  provider,
  styles,
  t,
}: {
  provider: ProviderEntry;
  styles: Styles;
  t: Translate;
}) {
  // The web row's fallback order (`ProviderSettingsSection.tsx:18-20`), and a
  // caption that swaps the base URL for the provider kind: a long URL is noise
  // on a phone and is not in the signed row.
  const name = provider.name || provider.model || provider.id;
  return (
    <View style={styles.provider} testID={`provider:${provider.id}`}>
      <View style={styles.providerHeading}>
        <Text style={styles.providerName}>{name}</Text>
        {provider.active ? (
          <Text style={styles.activeBadge}>
            {t("settings.provider.activeBadge")}
          </Text>
        ) : null}
      </View>
      <Text style={styles.providerSummary}>
        {`${provider.model} · ${provider.kind}`}
      </Text>
    </View>
  );
}

export default function ProviderUsage({
  state,
  t,
  onSelectWindow,
  onRefresh,
  onClose,
  autoFocus,
}: ProviderUsageScreenProps) {
  const { colors } = useTheme();
  const styles = useMemo(() => makeStyles(colors), [colors]);
  const titleRef = useRef<ViewInstance | null>(null);
  // One open is one mount: the sheet's Modal unmounts this subtree while it is
  // hidden, so the reader is moved once per open and never on an in-place
  // update (`Approvals.tsx:70-79` is the same one-transition rule).
  useEffect(() => {
    if (autoFocus) focusNode(titleRef);
  }, [autoFocus]);

  const totals = summarizeUsage(state.usage);
  // The window's spend per agent, folded from `UsageRow.agent` only (R6). The
  // provider list below is configuration, not a source of spend.
  const agents = useMemo(() => usageByAgent(state.usage), [state.usage]);
  // The model's two kinds of "nothing" (`providersModel.ts:252-258`).
  const deviceEmpty = state.status === "empty";
  // An expired token is a pairing state: the model already cleared the rows,
  // and this screen must not put a zero or an empty tile in their place.
  const expired =
    state.status === "failed" && state.error?.reason === "expired";
  // The last good rows a failed or offline read kept (`providersModel.ts:222-229`).
  const hasData = state.providers.length > 0 || state.usage.length > 0;
  // No data yet is not a quiet window: a first read in flight or a first read
  // that failed must not put four "—" tiles where nothing was ever read.
  const showTiles =
    !deviceEmpty && !expired && (state.status === "ready" || hasData);
  // The first read has nothing to show, so its slow state is the sheet's
  // skeleton (`KIN-MOBILE-001.md:123`). A refresh keeps the rows and numbers
  // already read (`providersModel.ts:202-229`) and must not cover them.
  const showSkeleton = state.status === "loading" && !hasData;

  // One line for the state that is not a plain success. Offline wins when it
  // kept rows: it names the network, which is the actionable fact; a stale
  // failure says the last read is what is on screen; a first-read failure --
  // offline included -- names its reason.
  const notice =
    state.status === "offline" && (hasData || state.error?.stale)
      ? t("settings.disconnected")
      : state.error?.stale
        ? t("agents.intervalFailed")
        : state.error
          ? t(failureKey(state.error.reason))
          : null;
  const canRetry =
    Boolean(onRefresh) &&
    (state.status === "failed" || state.status === "offline");

  return (
    <ScrollView
      contentContainerStyle={styles.content}
      style={styles.screen}
      testID="provider-usage-screen"
    >
      <View style={styles.header}>
        <Text
          accessibilityRole="header"
          ref={titleRef}
          style={styles.headerTitle}
          testID="usage-title"
        >
          {t("usage.title")}
        </Text>
        {onClose ? (
          <Pressable
            accessibilityLabel={t("app.close")}
            accessibilityRole="button"
            onPress={onClose}
            style={styles.control}
            testID="usage-close"
          >
            <Text style={styles.controlText}>{t("app.close")}</Text>
          </Pressable>
        ) : null}
      </View>

      <View style={styles.segmented} testID="usage-window-control">
        {USAGE_WINDOWS.map((days) => {
          const selected = state.days === days;
          const label = t(WINDOW_LABEL_KEYS[days]);
          return (
            <Pressable
              accessibilityLabel={label}
              accessibilityRole="button"
              accessibilityState={{ selected }}
              key={days}
              onPress={() => onSelectWindow(days)}
              style={[styles.window, selected && styles.windowSelected]}
              testID={`usage-window:${days}`}
            >
              <Text
                style={[
                  styles.windowText,
                  selected && styles.windowTextSelected,
                ]}
              >
                {label}
              </Text>
            </Pressable>
          );
        })}
      </View>

      {showSkeleton ? <UsageSkeleton t={t} /> : null}

      {notice ? (
        <View style={styles.notice}>
          <Text accessibilityRole="alert" style={styles.noticeText}>
            {notice}
          </Text>
          {canRetry ? (
            <Pressable
              accessibilityLabel={t("pairing.retry")}
              accessibilityRole="button"
              onPress={onRefresh}
              style={styles.control}
              testID="usage-retry"
            >
              <Text style={styles.controlText}>{t("pairing.retry")}</Text>
            </Pressable>
          ) : null}
        </View>
      ) : null}

      {deviceEmpty ? (
        <View style={styles.empty}>
          <Text style={styles.emptyTitle}>{t("agents.emptyUsageDevice")}</Text>
          <Text style={styles.emptyHint}>{t("agents.emptyUsageHint")}</Text>
        </View>
      ) : null}

      {agents.length > 0 ? (
        <View style={styles.agents} testID="usage-agents">
          {agents.map((entry) => (
            <AgentRow
              colors={colors}
              entry={entry}
              key={entry.agent}
              styles={styles}
              t={t}
            />
          ))}
          <View style={styles.totalRule} />
          <Text style={styles.windowTotal} testID="usage-window-total">
            {`${t("usage.spend")} ${formatSpend(totals.cost)} · ${t(
              "usage.tokens",
            )} ${formatTokenCount(totals.tokens)}`}
          </Text>
        </View>
      ) : null}

      {showTiles ? (
        <>
          <View style={styles.tiles}>
            <Tile
              label={t("usage.spend")}
              styles={styles}
              testID="spend"
              value={totals.empty ? NO_VALUE : formatSpend(totals.cost)}
            />
            <Tile
              label={t("usage.tokens")}
              styles={styles}
              testID="tokens"
              value={totals.empty ? NO_VALUE : formatTokenCount(totals.tokens)}
            />
            <Tile
              label={t("usage.cacheHitRate")}
              styles={styles}
              testID="cache"
              value={
                totals.empty
                  ? NO_VALUE
                  : cacheRateLabel(
                      totals.cacheStatus,
                      totals.cacheEligible > 0
                        ? totals.cacheRead / totals.cacheEligible
                        : null,
                    )
              }
            />
            <Tile
              label={t("usage.tasks")}
              styles={styles}
              testID="tasks"
              value={totals.empty ? NO_VALUE : String(totals.tasks)}
            />
          </View>
          {state.status === "ready" && totals.empty ? (
            // A quiet window under a configured provider: the range line, not
            // the device-level hint (the provider row is still drawn below).
            <Text style={styles.quiet}>{t("agents.emptyUsage")}</Text>
          ) : null}
        </>
      ) : null}

      {state.providers.length > 0 || state.providerListError ? (
        <View style={styles.providers}>
          {state.providers.map((provider) => (
            <ProviderRow
              key={provider.id}
              provider={provider}
              styles={styles}
              t={t}
            />
          ))}
          {state.providerListError ? (
            // The list alone is unreadable (a paired device token may not read
            // the operator-only endpoint). The numbers above are this read's,
            // and the whole-sheet notice must not claim the link is invalid.
            <Text
              accessibilityRole="alert"
              style={styles.providerNotice}
              testID="usage-provider-list-error"
            >
              {t("usage.providerListUnavailable")}
            </Text>
          ) : null}
        </View>
      ) : null}
    </ScrollView>
  );
}

const makeStyles = (colors: Palette) => StyleSheet.create({
  /** Every chip, the close control and the retry are ≥44pt (TASTE 11). */
  control: {
    alignItems: "center",
    borderColor: colors.hairlineStrong,
    borderRadius: 8,
    borderWidth: 1,
    justifyContent: "center",
    minHeight: 44,
    minWidth: 44,
    paddingHorizontal: 12,
    paddingVertical: 8,
  },
  controlText: {
    color: colors.blueInk,
    fontSize: 15,
    fontWeight: "600",
  },
  activeBadge: {
    color: colors.blueInk,
    fontSize: 12,
    fontWeight: "700",
    letterSpacing: 0.6,
    textTransform: "uppercase",
  },
  /** The identity colour's proportional fill; the track is the quiet part. */
  agentBar: {
    borderRadius: 3,
    height: 6,
  },
  agentCost: {
    color: colors.text,
    fontSize: 15,
    fontWeight: "600",
    marginLeft: "auto",
    textAlign: "right",
    ...tabular,
  },
  agentDetail: {
    color: colors.muted,
    fontSize: 12,
  },
  agentHeading: {
    alignItems: "center",
    flexDirection: "row",
    gap: 8,
  },
  agentName: {
    color: colors.text,
    flexShrink: 1,
    fontSize: 16,
    fontWeight: "600",
  },
  agentRow: {
    gap: 6,
  },
  /** One block per spending agent, closed by the window total. */
  agents: {
    gap: 14,
  },
  agentTrack: {
    backgroundColor: colors.fill,
    borderRadius: 3,
    height: 6,
    overflow: "hidden",
  },
  content: {
    gap: 12,
    padding: 16,
    paddingBottom: 32,
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
  header: {
    alignItems: "center",
    flexDirection: "row",
    gap: 12,
    justifyContent: "space-between",
  },
  headerTitle: {
    color: colors.text,
    fontSize: 20,
    fontWeight: "700",
  },
  /** The 10pt decorative mark; the row's text carries the meaning. */
  identityDot: {
    borderRadius: 5,
    height: 10,
    width: 10,
  },
  notice: {
    alignItems: "center",
    backgroundColor: wash(colors.orange, 0.15),
    borderRadius: 8,
    flexDirection: "row",
    flexWrap: "wrap",
    gap: 8,
    padding: 12,
  },
  noticeText: {
    color: colors.orangeInk,
    flexShrink: 1,
    fontSize: 14,
  },
  provider: {
    borderColor: colors.hairlineStrong,
    borderRadius: 12,
    borderWidth: 1,
    gap: 4,
    padding: 12,
  },
  providerHeading: {
    alignItems: "center",
    flexDirection: "row",
    flexWrap: "wrap",
    gap: 8,
  },
  providerName: {
    color: colors.text,
    flexShrink: 1,
    fontSize: 16,
    fontWeight: "600",
  },
  providers: {
    gap: 8,
  },
  providerNotice: {
    color: colors.muted,
    fontSize: 14,
  },
  providerSummary: {
    color: colors.muted,
    fontFamily: "monospace",
    fontSize: 13,
  },
  quiet: {
    color: colors.muted,
    fontSize: 14,
  },
  screen: {
    flex: 1,
  },
  /** One inset track: three equal segments, the chosen one elevated (R6). */
  segmented: {
    backgroundColor: colors.fill,
    borderRadius: 8,
    flexDirection: "row",
    gap: 2,
    padding: 2,
  },
  totalRule: {
    backgroundColor: colors.hairline,
    height: 1,
  },
  tile: {
    backgroundColor: colors.fill,
    borderRadius: 12,
    flexBasis: "47%",
    flexGrow: 1,
    gap: 4,
    padding: 12,
  },
  tileLabel: {
    color: colors.muted,
    fontSize: 12,
    fontWeight: "600",
    letterSpacing: 0.6,
    textTransform: "uppercase",
  },
  tileValue: {
    color: colors.text,
    fontVariant: ["tabular-nums"],
    fontSize: 22,
    fontWeight: "700",
  },
  tiles: {
    flexDirection: "row",
    flexWrap: "wrap",
    gap: 12,
  },
  /** A 44pt target even though the visible track is denser (TASTE 11). */
  window: {
    alignItems: "center",
    borderRadius: 6,
    flex: 1,
    justifyContent: "center",
    minHeight: 44,
    paddingHorizontal: 8,
    paddingVertical: 8,
    minWidth: 44,
  },
  windowSelected: {
    backgroundColor: colors.elevated,
  },
  windowText: {
    color: colors.muted,
    fontSize: 13,
  },
  windowTextSelected: {
    color: colors.text,
    fontWeight: "600",
  },
  windowTotal: {
    color: colors.muted,
    fontSize: 13,
    ...tabular,
  },
});

type Styles = ReturnType<typeof makeStyles>;
