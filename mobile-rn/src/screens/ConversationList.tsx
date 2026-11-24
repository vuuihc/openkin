/**
 * KIN-MOBILE-001 R3 — the conversation list, phone presentation.
 *
 * Pure: it renders the view state the model produced and calls back with the
 * task id. Every user-visible word arrives through `t`; every row is one
 * ≥44pt target with a title line and a metadata line (KIN-CONTINUE-007).
 * Routing, data loading and transport stay outside this component.
 */

import { Pressable, SectionList, StyleSheet, Text, View } from "react-native";
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

/** The list header band, and the bottom tab bar the list sits above. */
export const LIST_HEADER_HEIGHT = 56;
export const BOTTOM_TAB_INSET = 64;

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
  /**
   * A network state, not a steady one: present only while the screen is
   * reconnecting or has given up. It draws above the list header and never
   * over a row.
   */
  resume?: ResumeBandState;
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
      <Text accessibilityLiveRegion="polite" style={styles.resumeText}>
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

export default function ConversationList({
  state,
  t,
  onOpen,
  onRefresh,
  onToggleProject,
  resume,
}: ConversationListProps) {
  // An empty device (`includeEmptyDevices`) still yields a section, and a
  // SectionList with sections never draws `ListEmptyComponent` — so an empty
  // read would show a bare heading instead of the empty/offline words.
  const hasRows = state.groups.some((device) => device.count > 0);
  const sections = hasRows ? sectionsOf(state.groups) : [];

  return (
    <SectionList<Entry, Section>
      sections={sections}
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
              accessibilityState={{ expanded: item.project.open }}
              onPress={() => onToggleProject?.(item.deviceId, item.project.key)}
              style={styles.project}
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
        return (
          <Pressable
            accessibilityLabel={[row.title, meta, pendingLabel]
              .filter(Boolean)
              .join(" · ")}
            accessibilityRole="button"
            onPress={() => onOpen(row.id)}
            style={styles.row}
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
        resume ||
        (hasRows && (state.status === "failed" || state.status === "offline")) ? (
          <View>
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
          </View>
        ) : undefined
      }
      ListEmptyComponent={
        <View style={styles.empty}>
          {state.status === "loading" ? (
            <Text style={styles.emptyTitle}>{t("sessions.loading")}</Text>
          ) : state.status === "empty" ? (
            <>
              <Text style={styles.emptyTitle}>{t("sessions.empty")}</Text>
              <Text style={styles.emptyHint}>{t("sessions.emptyHint")}</Text>
            </>
          ) : state.status === "failed" || state.status === "offline" ? (
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
          ) : null}
        </View>
      }
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
  title: {
    color: "#1d1d1d",
    fontSize: 16,
    fontWeight: "500",
  },
});
