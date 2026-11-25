/**
 * KIN-MOBILE-001 R4 §3 — the conversation's first load, before its read answers.
 *
 * The signed slow-state cell asks for a message-area skeleton while the header
 * and composer are already usable: five body bars and one tool-row bar, the
 * shape of an answer rather than a lone caption over blank space. The bars are
 * decorative and are neither messages nor accessible stops; the one spoken
 * word is the container's label, `common.loading` — the sentence the catalogue
 * already has, so this adds no string. A static shape, exactly as the list
 * ships: no shimmer, no dependency (TASTE 15).
 */

import { StyleSheet, View } from "react-native";

/** The rhythm of an answer: long lines with one short line to close it. */
const BODY_WIDTHS = ["92%", "78%", "86%", "90%", "54%"] as const;

type ConversationSkeletonProps = {
  t: (key: string, params?: Record<string, string | number>) => string;
};

export default function ConversationSkeleton({
  t,
}: ConversationSkeletonProps) {
  return (
    <View
      accessible
      accessibilityLabel={t("common.loading")}
      testID="conversation-skeleton"
    >
      {BODY_WIDTHS.map((width, bar) => (
        <View
          key={bar}
          style={[styles.bodyBar, { width }]}
          testID="conversation-skeleton-bar"
        />
      ))}
      <View style={styles.toolRow} testID="conversation-skeleton-tool" />
    </View>
  );
}

const styles = StyleSheet.create({
  bodyBar: {
    backgroundColor: "#ececec",
    borderRadius: 4,
    height: 14,
    // The transcript's own horizontal rhythm, so the shape holds its place.
    marginHorizontal: 16,
    marginVertical: 6,
  },
  toolRow: {
    // Slightly darker than the body, as a real tool row reads above prose.
    backgroundColor: "#dcdcdc",
    borderRadius: 4,
    marginHorizontal: 16,
    marginVertical: 6,
    // The signed touch floor the real tool row takes (KIN-MOBILE-001).
    minHeight: 44,
    width: "60%",
  },
});
