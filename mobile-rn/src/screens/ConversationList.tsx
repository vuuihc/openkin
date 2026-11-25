/**
 * KIN-MOBILE-001 R3 — the conversation list, phone presentation.
 *
 * Pure: it renders the view state the model produced and calls back with the
 * task id. Every user-visible word arrives through `t`; every row is one
 * ≥44pt target with a title line and a metadata line (KIN-CONTINUE-007).
 * Routing, data loading and transport stay outside this component.
 */

import { useRef, useState } from "react";
import {
  Pressable,
  SectionList,
  StyleSheet,
  Text,
  TextInput,
  View,
} from "react-native";
import { isRowKey, moveRow, openRow } from "../list/listKeys";
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

/**
 * The paint a row or a project heading takes while a finger holds it. The
 * held state is Pressable's own; this is the one colour both surfaces share.
 */
export const PRESSED_BG = "#ececec";

/**
 * The keyboard ring's colour (KIN-MOBILE-001 §2). Visual only: the ring never
 * becomes a second accessibility element, and it paints on the row's own box
 * so the 56pt height does not move.
 */
export const FOCUS_RING = "#0b57d0";

/** The list header band, and the bottom tab bar the list sits above. */
export const LIST_HEADER_HEIGHT = 56;
export const BOTTOM_TAB_INSET = 64;

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
  t,
}: {
  resume: ResumeBandState;
  t: ConversationListProps["t"];
}) {
  return (
    <View style={styles.resumeBand}>
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
 * The list's shape before its first answer: one device heading bar and three
 * row bars. The bars are decorative and are neither rows nor accessible stops;
 * the one spoken word is the container's label (KIN-MOBILE-001 §2 慢 and
 * 键盘与焦点: every real row is one stop, a bar is none).
 */
function ListSkeleton({ t }: { t: ConversationListProps["t"] }) {
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
  resume,
}: ConversationListProps) {
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

  const focusRow = (rowId: string, scroll = false) => {
    if (rowId === focusedId) return;
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
      if (target !== null) onOpen(target);
      return;
    }
    focusRow(moveRow(rowIds, focusedId, key), true);
  };

  return (
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
        <View style={styles.deviceHeading}>
          <Text accessibilityRole="header" style={styles.deviceLabel}>
            {section.device.label}
          </Text>
          <Text style={styles.deviceCount}>{section.device.count}</Text>
        </View>
      )}
      renderItem={({ item }) => {
        if (item.kind === "project") {
          return (
            <Pressable
              accessibilityRole="button"
              accessibilityState={{
                expanded: item.project.open,
                disabled: searching,
              }}
              disabled={searching}
              onPress={() => onToggleProject?.(item.deviceId, item.project.key)}
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
        return (
          <Pressable
            accessibilityLabel={[row.title, meta, pendingLabel]
              .filter(Boolean)
              .join(" · ")}
            accessibilityRole="button"
            onPress={() => {
              // A tapped row is where the reader left the list, so the ring
              // rests there when they come back.
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
            <Text numberOfLines={1} style={styles.title}>
              {row.title}
            </Text>
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
          </Pressable>
        );
      }}
      ListHeaderComponent={
        <View>
          {/*
            The same catalogue word is the hint and the spoken name; the clear
            control only exists while there is something to clear, and the
            field itself is the list's own first stop.
          */}
          <View style={styles.searchBar}>
            <TextInput
              accessibilityLabel={t("sessions.searchPlaceholder")}
              autoCapitalize="none"
              autoCorrect={false}
              onChangeText={onQueryChange}
              onBlur={() => setSearchFocused(false)}
              onFocus={() => setSearchFocused(true)}
              placeholder={t("sessions.searchPlaceholder")}
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
          {resume ? <ResumeBand resume={resume} t={t} /> : null}
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
          {firstLoad ? <ListSkeleton t={t} /> : null}
        </View>
      }
      ListEmptyComponent={firstLoad ? undefined : (
        <View style={styles.empty}>
          {state.status === "empty" ? (
            <>
              <Text style={styles.emptyTitle}>{t("sessions.empty")}</Text>
              <Text style={styles.emptyHint}>{t("sessions.emptyHint")}</Text>
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
  );
}

const styles = StyleSheet.create({
  banner: {
    alignItems: "center",
    backgroundColor: "#fdf3d7",
    flexDirection: "row",
    gap: 12,
    minHeight: ROW_MIN_HEIGHT,
    paddingHorizontal: 16,
  },
  bannerText: {
    color: "#6b4b00",
    flex: 1,
    fontSize: 14,
  },
  deviceCount: {
    color: "#6b6b6b",
    fontSize: 13,
  },
  deviceHeading: {
    alignItems: "center",
    backgroundColor: "#f4f4f4",
    flexDirection: "row",
    justifyContent: "space-between",
    minHeight: ROW_MIN_HEIGHT,
    paddingHorizontal: 16,
  },
  deviceLabel: {
    color: "#3a3a3a",
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
    color: "#6b6b6b",
    fontSize: 14,
    textAlign: "center",
  },
  emptyTitle: {
    color: "#1d1d1d",
    fontSize: 16,
    fontWeight: "600",
  },
  meta: {
    color: "#6b6b6b",
    flex: 1,
    fontSize: 13,
  },
  metaLine: {
    alignItems: "center",
    flexDirection: "row",
    gap: 8,
  },
  pending: {
    backgroundColor: "#b3261e",
    borderRadius: 10,
    color: "#ffffff",
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
    backgroundColor: PRESSED_BG,
  },
  projectLabel: {
    color: "#1d1d1d",
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
    color: "#0b57d0",
    fontSize: 15,
    fontWeight: "600",
  },
  searchBar: {
    alignItems: "center",
    borderBottomColor: "#ececec",
    borderBottomWidth: StyleSheet.hairlineWidth,
    flexDirection: "row",
    minHeight: ROW_MIN_HEIGHT,
    paddingLeft: 16,
  },
  searchClear: {
    alignItems: "center",
    justifyContent: "center",
    // The signed touch floor, on the query's one control.
    minHeight: ROW_MIN_HEIGHT,
    minWidth: ROW_MIN_HEIGHT,
  },
  searchClearText: {
    color: "#6b6b6b",
    fontSize: 22,
    lineHeight: 24,
  },
  searchInput: {
    flex: 1,
    fontSize: 16,
    minHeight: ROW_MIN_HEIGHT,
    paddingRight: 8,
    paddingVertical: 8,
  },
  resumeBand: {
    alignItems: "center",
    backgroundColor: "#e8f0fe",
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
    color: "#0b57d0",
    fontSize: 15,
    fontWeight: "600",
  },
  resumeText: {
    color: "#0b3d91",
    flex: 1,
    fontSize: 14,
  },
  row: {
    borderBottomColor: "#ececec",
    borderBottomWidth: StyleSheet.hairlineWidth,
    height: ROW_HEIGHT,
    justifyContent: "center",
    minHeight: ROW_MIN_HEIGHT,
    paddingHorizontal: 16,
    paddingVertical: 8,
  },
  rowPressed: {
    backgroundColor: PRESSED_BG,
  },
  rowFocused: {
    // A ring on the row's own box: the fixed height absorbs the border, so
    // neither ROW_HEIGHT nor the 44pt floor moves.
    borderColor: FOCUS_RING,
    borderWidth: 2,
  },
  skeletonHeading: {
    backgroundColor: "#dcdcdc",
    borderRadius: 4,
    height: 12,
    marginHorizontal: 16,
    // The device heading's own band, so the shape holds its rhythm.
    marginVertical: (ROW_MIN_HEIGHT - 12) / 2,
    width: 96,
  },
  skeletonRow: {
    backgroundColor: "#ececec",
    borderRadius: 4,
    height: 14,
    marginHorizontal: 16,
    // Centred in the signed row height the real rows will take.
    marginVertical: (ROW_HEIGHT - 14) / 2,
    width: "62%",
  },
  title: {
    color: "#1d1d1d",
    fontSize: 16,
    fontWeight: "500",
  },
});
