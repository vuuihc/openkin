import { useMemo } from "react";
import type { ReactNode } from "react";
import { StyleSheet, Text, View } from "react-native";
import { splitFor } from "./split";
import { useTheme } from "../theme/useTheme";
import type { Palette } from "../theme/tokens";

/**
 * KIN-MOBILE-001 R3 — the list's split presentation (KIN-CONTINUE-007).
 *
 * Pure: it decides nothing about data and dispatches no request of its own
 * (the list and the conversation each bring their own bounded read), so it
 * adds no wait that could go unbounded. The right pane is keyed by the
 * selected task id: a selection change remounts the conversation instead of
 * letting the previous conversation's late answer paint under the new title
 * (AGENTS.md §11). Below 768 the list alone is rendered — the phone stack
 * lives in the routes, not here.
 *
 * The list keeps the same host wrapper in both modes, so crossing 768 on
 * rotation does not remount the list and lose its scroll position (TASTE 15);
 * only the width and the right pane change.
 */

export type SplitListLayoutProps = {
  /** The window width in points, straight from the platform. */
  width: number;
  /** The task id in the URL, or null when no conversation is open. */
  selectedTaskId: string | null;
  /** The empty pane's sentence, already translated by the caller. */
  emptyLabel: string;
  /** The conversation list; rendered at 304pt in split mode. */
  list: ReactNode;
  /** The conversation for `selectedTaskId`; ignored while it is null. */
  conversation: ReactNode;
};

export default function SplitListLayout({
  width,
  selectedTaskId,
  emptyLabel,
  list,
  conversation,
}: SplitListLayoutProps) {
  const { colors } = useTheme();
  const styles = useMemo(() => makeStyles(colors), [colors]);
  const layout = splitFor(width);
  const split = layout.mode === "split";

  return (
    <View style={[styles.root, split && styles.row]} testID="list-layout">
      <View
        style={[
          styles.listColumn,
          // `flex: 1` would put `flexBasis: 0` on the row's main axis and
          // override the signed width, so the split column opts out of both
          // grow and shrink and takes the width below.
          split
            ? { flexGrow: 0, flexShrink: 0, width: layout.listWidth }
            : styles.stackColumn,
        ]}
        testID={split ? "list-split-column" : "list-stack-column"}
      >
        {list}
      </View>
      {split ? (
        <>
          <View style={styles.divider} />
          <View
            key={selectedTaskId ?? "none"}
            style={styles.conversation}
            testID="list-split-conversation"
          >
            {selectedTaskId !== null && conversation !== null ? (
              conversation
            ) : (
              <View style={styles.empty}>
                <Text style={styles.emptyText}>{emptyLabel}</Text>
              </View>
            )}
          </View>
        </>
      ) : null}
    </View>
  );
}

const makeStyles = (colors: Palette) => StyleSheet.create({
  conversation: {
    flex: 1,
  },
  divider: {
    backgroundColor: colors.hairlineStrong,
    width: StyleSheet.hairlineWidth,
  },
  empty: {
    alignItems: "center",
    flex: 1,
    justifyContent: "center",
    padding: 24,
  },
  emptyText: {
    color: colors.muted,
    fontSize: 15,
    textAlign: "center",
  },
  listColumn: {
    height: "100%",
    overflow: "hidden",
  },
  root: {
    // The right pane paints nothing of its own: without this the empty pane
    // shows the navigator's white screen under a dark list (EVIDENCE.md D4).
    backgroundColor: colors.bg,
    flex: 1,
  },
  stackColumn: {
    flex: 1,
  },
  row: {
    flexDirection: "row",
  },
});
