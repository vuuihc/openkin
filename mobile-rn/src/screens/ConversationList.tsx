/**
 * KIN-MOBILE-001 R3 — the conversation list, phone presentation.
 *
 * Pure: it renders the view state the model produced and calls back with the
 * task id. Every user-visible word arrives through `t`; every row is one
 * ≥44pt target with a title line and a metadata line (KIN-CONTINUE-007).
 * Routing, data loading and transport stay outside this component.
 */

import { useContext, useEffect, useMemo, useRef, useState } from "react";
import {
  Pressable,
  SectionList,
  StyleSheet,
  Text,
  TextInput,
  View,
  type PressableInstance,
} from "react-native";
import {
  SafeAreaInsetsContext,
  type EdgeInsets,
} from "react-native-safe-area-context";
import { focusNode } from "../a11y/focus";
import { headerTopInset } from "../native/insets";
import { useTheme } from "../theme/useTheme";
import { palette, type, wash, type Palette } from "../theme/tokens";
import { isRowKey, moveRow, openRow } from "../list/listKeys";
import { rowMark, type RowMark as RowMarkState } from "../list/rowMark";
import type {
  ConversationRow,
  DeviceGroup,
  ListViewState,
  ProjectGroup,
} from "../list/listModel";

/** The signed touch floor. */
export const ROW_MIN_HEIGHT = 44;

/** Two lines (title + metadata) with room to breathe. */
export const ROW_HEIGHT = 56;

/** The status mark's column, and the gap between it and the two text lines. */
export const MARK_SLOT_WIDTH = 10;
export const MARK_GAP = 8;

/**
 * The paint a row or a project heading takes while a finger holds it. The
 * held state is Pressable's own; this is the one colour both surfaces share.
 * Kept as the light-scheme value for the suites that import it; the rendered
 * style takes `colors.fillStrong` so dark mode gets the dark step.
 */
export const PRESSED_BG = palette.light.fillStrong;

/**
 * The keyboard ring's colour (KIN-MOBILE-001 §2). Visual only: the ring never
 * becomes a second accessibility element, and it paints on the row's own box
 * so the 56pt height does not move.
 */
export const FOCUS_RING = palette.light.focusRing;

/** The list header band, and the bottom tab bar the list sits above. */
export const LIST_HEADER_HEIGHT = 56;
export const BOTTOM_TAB_INSET = 64;

/** A provider that reports nothing is a device without a status-bar inset. */
const NO_INSETS: EdgeInsets = { top: 0, right: 0, bottom: 0, left: 0 };

/**
 * How long a failed scroll waits for the list to lay an off-window row out
 * before placing it again. One retry only; a newer move supersedes it.
 */
const SCROLL_RETRY_MS = 100;

/**
 * Whole rows one 820×1180 coarse-pointer screenful holds, computed from the
 * same constants the rows use. The signed floor is 10 (KIN-CONTINUE-007).
 */
export function rowsOnScreen(
  screenHeight: number,
  header = LIST_HEADER_HEIGHT,
  tabInset = BOTTOM_TAB_INSET,
): number {
  return Math.max(
    0,
    Math.floor((screenHeight - header - tabInset) / ROW_HEIGHT),
  );
}

type Entry =
  | { kind: "project"; deviceId: string; project: ProjectGroup }
  | { kind: "row"; row: ConversationRow };

type Section = { device: DeviceGroup; data: Entry[] };

/** The resume controller's reader-facing state, owned by the container. */
export type ResumeBandState = {
  status: "resuming" | "offline";
  onRetry: () => void;
};

export type ConversationListProps = {
  state: ListViewState;
  t: (key: string, params?: Record<string, string | number>) => string;
  onOpen: (taskId: string) => void;
  onRefresh: () => void;
  onToggleProject?: (deviceId: string, projectKey: string) => void;
  /** The current search term; the container owns it and the fold it makes. */
  query: string;
  onQueryChange: (next: string) => void;
  /** The offset a remount starts at, and every scroll the reader makes. */
  initialOffset?: number;
  onScrollOffset?: (offset: number) => void;
  /** The row the ring is on when the list mounts (KIN-MOBILE-001 §2). */
  initialFocusId?: string;
  /** Every move of the ring, so the route can remember where the reader was. */
  onFocusChange?: (rowId: string) => void;
  /**
   * Bumped only when the list route itself regains focus (Back from a pushed
   * conversation). Distinct from the data epoch the container re-reads on: a
   * split open/switch/close is not a return and must not move the reader.
   */
  returnFocusEpoch?: number;
  /**
   * A network state, not a steady one: present only while the screen is
   * reconnecting or has given up. It draws above the list header and never
   * over a row.
   */
  resume?: ResumeBandState;
};

/**
 * The slice of React Native's key event this screen reads. `KeyDownEvent` is
 * assignable to it; the test renderer can deliver the same two fields without
 * a native key pipeline.
 */
type ListKeyEvent = {
  nativeEvent: { key: string };
  preventDefault?: () => void;
};

/**
 * The reconnect band. One control at most: while the refresh is in flight
 * there is nothing to press, and after it gives up the single retry is the
 * reader's one manual action (KIN-MOBILE-001 §8).
 */
function ResumeBand({
  resume,
  styles,
  t,
}: {
  resume: ResumeBandState;
  styles: Styles;
  t: ConversationListProps["t"];
}) {
  return (
    <View style={styles.resumeBand} testID="list-resume-band">
      <Text
        accessibilityLiveRegion="polite"
        // Android speaks the polite region; the offline state is also an
        // alert so iOS announces it and everyone hears the failure once.
        accessibilityRole={resume.status === "offline" ? "alert" : undefined}
        style={styles.resumeText}
      >
        {resume.status === "resuming"
          ? t("app.reconnecting")
          : t("pairing.unreachable")}
      </Text>
      {resume.status === "offline" ? (
        <Pressable
          accessibilityRole="button"
          onPress={resume.onRetry}
          style={styles.resumeRetry}
          testID="list-resume-retry"
        >
          <Text style={styles.resumeRetryText}>{t("pairing.retry")}</Text>
        </Pressable>
      ) : null}
    </View>
  );
}

/**
 * The row's status mark: a View-drawn shape and a token colour, never an icon
 * font or a new dependency (KIN-MOBILE-002 R3). Decorative by contract — the
 * row's spoken name already carries the signed status word — so the whole
 * slot hides itself from the screen reader.
 */
function RowMark({
  mark,
  colors,
  styles,
}: {
  mark: RowMarkState;
  colors: Palette;
  styles: Styles;
}) {
  // The tone is the fill pigment; `muted` is the design's grey step.
  const tone =
    mark.tone === "blue"
      ? colors.blue
      : mark.tone === "orange"
        ? colors.orange
        : mark.tone === "red"
          ? colors.red
          : colors.muted;
  return (
    <View
      accessibilityElementsHidden
      importantForAccessibility="no-hide-descendants"
      style={styles.markSlot}
      testID="row-mark"
    >
      {mark.shape === "dot" ? (
        <View
          style={{ backgroundColor: tone, borderRadius: 999, height: 8, width: 8 }}
          testID="mark-dot"
        />
      ) : mark.shape === "square" ? (
        <View
          style={{ backgroundColor: tone, borderRadius: 2, height: 8, width: 8 }}
          testID="mark-square"
        />
      ) : mark.shape === "triangle" ? (
        // A zero-width box whose bottom border is the triangle; a View border
        // is how RN draws a shape without an asset.
        <View
          style={{
            borderBottomColor: tone,
            borderBottomWidth: 8,
            borderLeftColor: "transparent",
            borderLeftWidth: 5,
            borderRightColor: "transparent",
            borderRightWidth: 5,
            height: 0,
            width: 0,
          }}
          testID="mark-triangle"
        />
      ) : null}
    </View>
  );
}

/**
 * The list's shape before its first answer: one device heading bar and three
 * row bars. The bars are decorative and are neither rows nor accessible stops;
 * the one spoken word is the container's label (KIN-MOBILE-001 §2 慢 and
 * 键盘与焦点: every real row is one stop, a bar is none).
 */
function ListSkeleton({ styles, t }: { styles: Styles; t: ConversationListProps["t"] }) {
  return (
    <View
      accessible
      accessibilityLabel={t("sessions.loading")}
      testID="list-skeleton"
    >
      <View style={styles.skeletonHeading} testID="list-skeleton-heading" />
      {[0, 1, 2].map((bar) => (
        <View key={bar} style={styles.skeletonRow} testID="list-skeleton-row" />
      ))}
    </View>
  );
}

/** The catalogue sentence for a failed read, by transport reason. */
function errorKey(state: ListViewState): string {
  switch (state.error) {
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

function sectionsOf(groups: readonly DeviceGroup[]): Section[] {
  return groups.map((device) => {
    const data: Entry[] = [];
    for (const project of device.projects) {
      data.push({ kind: "project", deviceId: device.id, project });
      if (!project.open) continue;
      for (const row of project.rows) data.push({ kind: "row", row });
    }
    return { device, data };
  });
}

/**
 * Where a row sits for `scrollToLocation`: its section and its item index in
 * that section's data. Project headings occupy item indices too, so a row is
 * not at its position among rows alone.
 */
function locateRow(
  sections: readonly Section[],
  rowId: string,
): { sectionIndex: number; itemIndex: number } | null {
  for (let sectionIndex = 0; sectionIndex < sections.length; sectionIndex += 1) {
    const itemIndex = sections[sectionIndex]!.data.findIndex(
      (entry) => entry.kind === "row" && entry.row.id === rowId,
    );
    if (itemIndex !== -1) return { sectionIndex, itemIndex };
  }
  return null;
}

export default function ConversationList({
  state,
  t,
  onOpen,
  onRefresh,
  onToggleProject,
  query,
  onQueryChange,
  initialOffset = 0,
  onScrollOffset,
  initialFocusId = "",
  onFocusChange,
  returnFocusEpoch = 0,
  resume,
}: ConversationListProps) {
  // The device's own insets, read by the list so both presentations agree: a
  // missing provider is a device that reports none, exactly as the
  // conversation header reads it (`ConversationView.tsx:776`).
  const insets = useContext(SafeAreaInsetsContext) ?? NO_INSETS;
  const { colors } = useTheme();
  const styles = useMemo(() => makeStyles(colors), [colors]);
  // An empty device (`includeEmptyDevices`) still yields a section, and a
  // SectionList with sections never draws `ListEmptyComponent` — so an empty
  // read would show a bare heading instead of the empty/offline words.
  const hasRows = state.groups.some((device) => device.count > 0);
  const sections = hasRows ? sectionsOf(state.groups) : [];
  // Nothing to show yet: no answer has landed and there is no cached page.
  // A page being refreshed keeps its rows and draws no skeleton (TASTE 15).
  const firstLoad = state.status === "loading" && !hasRows;
  // A query is view state over the page the container already filtered; the
  // project headings it opened are not the reader's folds, so toggling them
  // during a search would write a fold nobody can see.
  const searching = query.trim() !== "";
  const listRef = useRef<SectionList<Entry, Section>>(null);
  const restored = useRef(false);
  // The visible conversation rows in paint order. Project headings are not
  // rows: the arrows skip them and Enter on one does nothing.
  const rowIds = sections.flatMap((section) =>
    section.data.flatMap((entry) =>
      entry.kind === "row" ? [entry.row.id] : [],
    ),
  );
  // The ring's row. A row that a fold or a query hides keeps the id: no ring
  // is drawn while it is gone, and it comes back when the row does.
  const [focusedId, setFocusedId] = useState(initialFocusId);
  // While the caret is in the search field the arrows belong to the text.
  const [searchFocused, setSearchFocused] = useState(false);
  // The row the last keyboard move asked the list to reveal. A failed scroll
  // retries against it, and a newer move replaces it (AGENTS.md rule 11).
  const pendingScroll = useRef<{
    sectionIndex: number;
    itemIndex: number;
  } | null>(null);
  // The row nodes a return can move the reader to. SectionList paints only
  // the rows near the viewport, so the ringed row may not be committed yet.
  const rowRefs = useRef(new Map<string, PressableInstance>());
  // The row a return is still waiting to see painted. Its ref callback is the
  // only signal that the row exists now: no timer, no retry loop (AGENTS §13).
  const pendingReturn = useRef<string | null>(null);
  // The epoch this list mounted with is the baseline: only a later change is a
  // return, so the first paint (including a restored ring) moves nothing.
  const returnBaseline = useRef(returnFocusEpoch);

  // KIN-MOBILE-001 §2「返回时焦点回到那一行」: when the route reports that the
  // list itself regained focus, move the reader once to the row the ring is on.
  // The split's data-only epoch never reaches this prop, so opening, switching
  // or closing the conversation beside the list cannot steal the reader.
  useEffect(() => {
    if (returnBaseline.current === returnFocusEpoch) return;
    returnBaseline.current = returnFocusEpoch;
    // A deep link straight into a conversation never had an originating row:
    // nothing to return to, and the first row is not it.
    if (focusedId === "") return;
    const node = rowRefs.current.get(focusedId);
    if (node == null) {
      pendingReturn.current = focusedId;
      return;
    }
    pendingReturn.current = null;
    focusNode({ current: node });
  }, [returnFocusEpoch, focusedId]);

  /**
   * A reader action that moves them off the rows drops a return still waiting
   * for its row to paint: a focus move that lands later would steal them from
   * wherever they are now (AGENTS.md rule 11).
   */
  const dropPendingReturn = () => {
    pendingReturn.current = null;
  };

  const focusRow = (rowId: string, scroll = false) => {
    if (rowId === focusedId) return;
    // A newer move supersedes a return still waiting for its row to paint.
    dropPendingReturn();
    setFocusedId(rowId);
    onFocusChange?.(rowId);
    if (!scroll) return;
    // The list is virtualized: a row past the fold is painted nowhere, so the
    // ring would be invisible and Enter would open a row the reader cannot
    // see. Reveal the row the ring lands on.
    const where = locateRow(sections, rowId);
    if (where === null) return;
    pendingScroll.current = where;
    listRef.current?.scrollToLocation({
      ...where,
      animated: true,
      viewPosition: 0.5,
    });
  };

  const handleKeyDown = (event: ListKeyEvent) => {
    if (searchFocused) return;
    const key = event?.nativeEvent?.key;
    if (typeof key !== "string" || !isRowKey(key)) return;
    // A handled key never scrolls the list or moves the caret instead.
    event?.preventDefault?.();
    if (key === "Enter") {
      const target = openRow(rowIds, focusedId);
      if (target !== null) {
        // The list is leaving for the conversation: a return still waiting
        // for a row must not land behind it (AGENTS.md rule 11).
        dropPendingReturn();
        onOpen(target);
      }
      return;
    }
    focusRow(moveRow(rowIds, focusedId, key), true);
  };

  return (
    <View style={styles.screen} testID="list-root">
      {/*
        The navigation bar is pinned: the list's title and its one search box
        stay put while the grouped rows scroll under them. This round ships the
        static large-title variant — no collapse-on-scroll tracking.
      */}
      <View
        style={[styles.navBar, { paddingTop: headerTopInset(insets.top) }]}
        testID="list-nav"
      >
        <Text accessibilityRole="header" style={styles.navTitle}>
          {t("nav.sessions")}
        </Text>
        <View style={styles.searchField}>
          <TextInput
            accessibilityLabel={t("sessions.searchPlaceholder")}
            autoCapitalize="none"
            autoCorrect={false}
            onChangeText={(next) => {
              // A query the reader is typing changes which rows can paint;
              // a return waiting for one of them is no longer their context.
              dropPendingReturn();
              onQueryChange(next);
            }}
            onBlur={() => setSearchFocused(false)}
            onFocus={() => {
              dropPendingReturn();
              setSearchFocused(true);
            }}
            placeholder={t("sessions.searchPlaceholder")}
            placeholderTextColor={colors.muted}
            returnKeyType="search"
            style={styles.searchInput}
            testID="list-search"
            value={query}
          />
          {query === "" ? null : (
            <Pressable
              accessibilityLabel={t("common.clear")}
              accessibilityRole="button"
              onPress={() => onQueryChange("")}
              style={styles.searchClear}
              testID="list-search-clear"
            >
              <Text style={styles.searchClearText}>{"×"}</Text>
            </Pressable>
          )}
        </View>
      </View>
      {/*
        The network band sits in the column above the scroll view, so it
        pushes the rows down instead of covering one (KIN-MOBILE-002 R3).
      */}
      {resume ? <ResumeBand resume={resume} styles={styles} t={t} /> : null}
      {/*
        The list keeps its existing indentation: the rows below are the same
        SectionList in a new column, and a whitespace-only re-indent would bury
        the row diff a reviewer has to read.
      */}
    <SectionList<Entry, Section>
      ref={listRef}
      // The handler seam, and the pure map behind it, are landed here; RN
      // 0.88.1 delivers key-down to Views only on Android and only with the
      // native `enableKeyEvents` flag, which no app-level prop turns on. A
      // native key source (or a future RN) drives this path; see the PR body.
      onKeyDown={handleKeyDown}
      onScrollToIndexFailed={(info) => {
        // The row is past the rendered window, so it has no measured frame:
        // jump near its estimated offset, then place it once it is laid out.
        listRef.current
          ?.getScrollResponder()
          ?.scrollTo({ y: info.averageItemLength * info.index, animated: false });
        const target = pendingScroll.current;
        if (target === null) return;
        setTimeout(() => {
          if (pendingScroll.current !== target) return;
          listRef.current?.scrollToLocation({
            ...target,
            animated: true,
            viewPosition: 0.5,
          });
        }, SCROLL_RETRY_MS);
      }}
      sections={sections}
      style={styles.screen}
      // iOS takes the restored offset before content lays out; the scroll
      // responder below covers the platforms that ignore it.
      contentOffset={{ x: 0, y: initialOffset }}
      onContentSizeChange={() => {
        if (restored.current || initialOffset === 0) return;
        restored.current = true;
        listRef.current
          ?.getScrollResponder()
          ?.scrollTo({ x: 0, y: initialOffset, animated: false });
      }}
      onScroll={(event) => onScrollOffset?.(event.nativeEvent.contentOffset.y)}
      scrollEventThrottle={16}
      testID="list-scroller"
      keyExtractor={(item) =>
        item.kind === "project"
          ? `project:${item.deviceId}:${item.project.key}`
          : `row:${item.row.id}`
      }
      renderSectionHeader={({ section }) => (
        <View style={styles.deviceHeading} testID={`device:${section.device.id}`}>
          <Text accessibilityRole="header" style={styles.deviceLabel}>
            {section.device.label}
          </Text>
          <Text style={styles.deviceCount}>{section.device.count}</Text>
        </View>
      )}
      renderItem={({ item, index, section }) => {
        if (item.kind === "project") {
          return (
            <Pressable
              accessibilityRole="button"
              accessibilityState={{
                expanded: item.project.open,
                disabled: searching,
              }}
              disabled={searching}
              onPress={() => {
                // The reader folded or unfolded a project; a return that was
                // waiting for a hidden row must not land after that.
                dropPendingReturn();
                onToggleProject?.(item.deviceId, item.project.key);
              }}
              style={({ pressed }) => [
                styles.project,
                pressed && styles.projectPressed,
              ]}
              testID={`project:${item.project.key}`}
            >
              <Text style={styles.projectLabel}>
                {item.project.open ? "▾" : "▸"} {item.project.label}
              </Text>
            </Pressable>
          );
        }
        const { row } = item;
        const meta = [
          row.agentId,
          row.timeLabel,
          row.statusKey ? t(row.statusKey) : null,
        ]
          .filter((part): part is string => Boolean(part))
          .join(" · ");
        // The row button is one accessible element; a child's label is never
        // read while the row has focus, so the count joins the row's words.
        const pendingLabel =
          row.pending > 0
            ? t("sessions.pendingApprovals", { count: row.pending })
            : null;
        const focused = row.id === focusedId;
        // The design's shape + colour mark (KIN-MOBILE-002 R3): decorative,
        // because the row's spoken name already carries the status word.
        const mark = rowMark(row);
        // An iOS grouped list closes the group on its last row: no separator
        // follows the last conversation row of a device section (a folded
        // project heading may still follow it).
        const lastRow = !section.data
          .slice(index + 1)
          .some((entry) => entry.kind === "row");
        return (
          <Pressable
            accessibilityLabel={[row.title, meta, pendingLabel]
              .filter(Boolean)
              .join(" · ")}
            accessibilityRole="button"
            ref={(node) => {
              if (node === null) {
                rowRefs.current.delete(row.id);
                return;
              }
              rowRefs.current.set(row.id, node);
              // A return that landed before this row was painted waits here;
              // the first committed ref is the row's arrival.
              if (pendingReturn.current !== row.id) return;
              pendingReturn.current = null;
              focusNode({ current: node });
            }}
            onPress={() => {
              // A tapped row is where the reader left the list, so the ring
              // rests there when they come back. `focusRow` drops a waiting
              // return too, but tapping the row already ringed early-returns.
              dropPendingReturn();
              focusRow(row.id);
              onOpen(row.id);
            }}
            style={({ pressed }) => [
              styles.row,
              pressed && styles.rowPressed,
              focused && styles.rowFocused,
            ]}
            testID={`row:${row.id}`}
          >
            <View style={styles.titleRow}>
              <RowMark mark={mark} colors={colors} styles={styles} />
              <Text numberOfLines={1} style={styles.title}>
                {row.title}
              </Text>
            </View>
            <View style={styles.metaLine}>
              <Text numberOfLines={1} style={styles.meta}>
                {meta}
              </Text>
              {pendingLabel ? (
                <Text accessibilityLabel={pendingLabel} style={styles.pending}>
                  {row.pending}
                </Text>
              ) : null}
            </View>
            {lastRow ? null : (
              <View style={styles.hairline} testID={`hairline:${row.id}`} />
            )}
          </Pressable>
        );
      }}
      ListHeaderComponent={
        <View>
          {/*
            While the resume band is up it is the one band: the list's own
            failure line would repeat the same sentence with a second retry.
          */}
          {!resume &&
          hasRows &&
          (state.status === "failed" || state.status === "offline") ? (
            <View style={styles.banner}>
              <Text accessibilityRole="alert" style={styles.bannerText}>
                {t(errorKey(state))}
              </Text>
              <Pressable
                accessibilityRole="button"
                onPress={onRefresh}
                style={styles.retry}
              >
                <Text style={styles.retryText}>{t("pairing.retry")}</Text>
              </Pressable>
            </View>
          ) : null}
          {/* The first frame is the list's own shape, under its header. */}
          {firstLoad ? <ListSkeleton styles={styles} t={t} /> : null}
        </View>
      }
      ListEmptyComponent={firstLoad ? undefined : (
        <View style={styles.empty}>
          {state.status === "empty" ? (
            // The phone client draws no 新建 entry, so the empty list names
            // none (KIN-MOBILE-001 §2 空; the entry is a separate start story).
            // Frame 06's two centred lines: the state, then where a chat comes
            // from, in the catalogue's own words.
            <>
              <Text style={styles.emptyTitle}>{t("sessions.empty")}</Text>
              <Text style={styles.emptyHint}>{t("sessions.deviceEmpty")}</Text>
            </>
          ) : state.status === "failed" || state.status === "offline" ? (
            resume ? (
              // The band already carries the reason and the one retry; with no
              // cached rows this repeats neither. While the series is still
              // running the empty screen is loading, not failed (KIN-MOBILE-001
              // §8: no cache shows a loading state, not an error).
              <>
                <Text style={styles.emptyTitle}>
                  {resume.status === "resuming"
                    ? t("sessions.loading")
                    : t("sessions.loadError")}
                </Text>
                {/*
                  The band's offline sentence is the generic network one; a
                  refused token or link needs its own signed words, and this is
                  the only place they can appear with no rows cached.
                */}
                {resume.status === "offline" &&
                state.error !== null &&
                state.error !== "unreachable" ? (
                  <Text style={styles.emptyHint}>{t(errorKey(state))}</Text>
                ) : null}
              </>
            ) : (
              <>
                <Text accessibilityRole="alert" style={styles.emptyTitle}>
                  {t("sessions.loadError")}
                </Text>
                <Text style={styles.emptyHint}>{t(errorKey(state))}</Text>
                <Pressable
                  accessibilityRole="button"
                  onPress={onRefresh}
                  style={styles.retry}
                >
                  <Text style={styles.retryText}>{t("pairing.retry")}</Text>
                </Pressable>
              </>
            )
          ) : searching ? (
            // The page is fine; the query simply has no row. Saying "no
            // chats" here would blame the account for the reader's filter.
            <Text style={styles.emptyTitle}>
              {t("sessions.searchEmpty", { query: query.trim() })}
            </Text>
          ) : null}
        </View>
      )}
      onRefresh={onRefresh}
      refreshing={state.status === "loading"}
      stickySectionHeadersEnabled={false}
    />
    </View>
  );
}

const makeStyles = (colors: Palette) => StyleSheet.create({
  screen: {
    // The window backdrop: grouped surfaces sit on it, the rows on `bg`.
    backgroundColor: colors.page,
    flex: 1,
  },
  banner: {
    alignItems: "center",
    backgroundColor: wash(colors.orange, 0.15),
    flexDirection: "row",
    gap: 12,
    minHeight: ROW_MIN_HEIGHT,
    paddingHorizontal: 16,
  },
  bannerText: {
    color: colors.orangeInk,
    flex: 1,
    fontSize: 14,
  },
  deviceCount: {
    color: colors.muted,
    fontSize: 13,
  },
  deviceHeading: {
    alignItems: "center",
    // The group's heading sits on the page, not on the rows' surface.
    backgroundColor: colors.page,
    flexDirection: "row",
    justifyContent: "space-between",
    minHeight: ROW_MIN_HEIGHT,
    paddingHorizontal: 16,
  },
  deviceLabel: {
    color: colors.secondary,
    fontSize: 13,
    fontWeight: "700",
    letterSpacing: 0.6,
    textTransform: "uppercase",
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
  meta: {
    color: colors.muted,
    flex: 1,
    fontSize: 13,
  },
  metaLine: {
    alignItems: "center",
    flexDirection: "row",
    gap: 8,
    // The second line starts on the title's own left edge, past the mark.
    paddingLeft: MARK_SLOT_WIDTH + MARK_GAP,
  },
  pending: {
    backgroundColor: colors.red,
    borderRadius: 10,
    color: colors.onStatus,
    fontSize: 12,
    fontWeight: "700",
    minWidth: 20,
    overflow: "hidden",
    paddingHorizontal: 6,
    paddingVertical: 1,
    textAlign: "center",
  },
  project: {
    justifyContent: "center",
    minHeight: ROW_MIN_HEIGHT,
    paddingHorizontal: 16,
  },
  projectPressed: {
    backgroundColor: colors.fillStrong,
  },
  projectLabel: {
    color: colors.text,
    fontSize: 15,
    fontWeight: "600",
  },
  retry: {
    alignItems: "center",
    justifyContent: "center",
    minHeight: ROW_MIN_HEIGHT,
    minWidth: ROW_MIN_HEIGHT,
    paddingHorizontal: 12,
  },
  retryText: {
    color: colors.blueInk,
    fontSize: 15,
    fontWeight: "600",
  },
  navBar: {
    alignItems: "center",
    backgroundColor: colors.page,
    borderBottomColor: colors.hairline,
    borderBottomWidth: StyleSheet.hairlineWidth,
    flexDirection: "row",
    gap: 12,
    minHeight: ROW_HEIGHT,
    paddingHorizontal: 16,
    paddingVertical: 6,
  },
  navTitle: {
    color: colors.text,
    ...type.largeTitle,
  },
  searchField: {
    alignItems: "center",
    backgroundColor: colors.fill,
    borderRadius: 10,
    flex: 1,
    flexDirection: "row",
    minHeight: ROW_MIN_HEIGHT,
    paddingLeft: 12,
  },
  searchClear: {
    alignItems: "center",
    justifyContent: "center",
    // The signed touch floor, on the query's one control.
    minHeight: ROW_MIN_HEIGHT,
    minWidth: ROW_MIN_HEIGHT,
  },
  searchClearText: {
    color: colors.muted,
    fontSize: 22,
    lineHeight: 24,
  },
  searchInput: {
    color: colors.text,
    flex: 1,
    fontSize: 16,
    minHeight: ROW_MIN_HEIGHT,
    paddingRight: 8,
    paddingVertical: 8,
  },
  resumeBand: {
    alignItems: "center",
    // The network state is the design's orange band; it sits above the list
    // in the column and never paints over a row.
    backgroundColor: wash(colors.orange, 0.15),
    flexDirection: "row",
    gap: 12,
    minHeight: ROW_MIN_HEIGHT,
    paddingHorizontal: 16,
  },
  resumeRetry: {
    alignItems: "center",
    justifyContent: "center",
    // The signed touch floor, on the one control the band offers.
    minHeight: ROW_MIN_HEIGHT,
    minWidth: ROW_MIN_HEIGHT,
    paddingHorizontal: 12,
  },
  resumeRetryText: {
    color: colors.orangeInk,
    fontSize: 15,
    fontWeight: "600",
  },
  resumeText: {
    color: colors.orangeInk,
    flex: 1,
    fontSize: 14,
  },
  row: {
    // A row paints its own surface: it must not inherit the platform's white.
    backgroundColor: colors.bg,
    // The visible separator is the inset hairline drawn below (a border
    // cannot be inset); the row keeps the token on its own box, which is the
    // separator the theme suite reads.
    borderBottomColor: colors.hairlineStrong,
    justifyContent: "center",
    // The design's ≥54pt grouped row; the whole box is the touch target.
    minHeight: ROW_HEIGHT,
    paddingHorizontal: 16,
    paddingVertical: 8,
  },
  hairline: {
    backgroundColor: colors.hairlineStrong,
    bottom: 0,
    height: StyleSheet.hairlineWidth,
    // Inset to the row's text, the iOS grouped-list rule.
    left: 16,
    position: "absolute",
    right: 0,
  },
  markSlot: {
    alignItems: "center",
    justifyContent: "center",
    width: MARK_SLOT_WIDTH,
  },
  titleRow: {
    alignItems: "center",
    flexDirection: "row",
    gap: MARK_GAP,
  },
  rowPressed: {
    backgroundColor: colors.fillStrong,
  },
  rowFocused: {
    // A ring on the row's own box: the fixed height absorbs the border, so
    // neither ROW_HEIGHT nor the 44pt floor moves.
    borderColor: colors.focusRing,
    borderWidth: 2,
  },
  skeletonHeading: {
    backgroundColor: colors.fillStrong,
    borderRadius: 4,
    height: 12,
    marginHorizontal: 16,
    // The device heading's own band, so the shape holds its rhythm.
    marginVertical: (ROW_MIN_HEIGHT - 12) / 2,
    width: 96,
  },
  skeletonRow: {
    backgroundColor: colors.fillStrong,
    borderRadius: 4,
    height: 14,
    marginHorizontal: 16,
    // Centred in the signed row height the real rows will take.
    marginVertical: (ROW_HEIGHT - 14) / 2,
    width: "62%",
  },
  title: {
    color: colors.text,
    flexShrink: 1,
    ...type.navTitle,
  },
});

type Styles = ReturnType<typeof makeStyles>;
