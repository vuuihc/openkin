/**
 * KIN-MOBILE-001 R6 — the usage sheet's first-open placeholder.
 *
 * The signed slow row is "sheet 骨架，关闭始终可用" (`KIN-MOBILE-001.md:123`).
 * This file draws only the shape: four tile boxes in the settled screen's 2×2
 * rhythm and three provider-row bars, using the same paddings and gaps so the
 * sheet does not jump when the read lands. The 7/30/90 chips, 关闭 and the
 * scrim stay the real controls in `ProviderUsage`/`ProviderUsageSheet`; none of
 * them is repeated here.
 *
 * One node for the reader: the container is `accessible` and speaks the
 * existing loading word (`usage.loading`) once. The bars carry no role, no
 * label and no handler, and their block is hidden from the accessibility tree,
 * so a swipe never stops on a placeholder and this slice adds no sentence and
 * no interaction (AGENTS.md §17).
 */

import { StyleSheet, View } from "react-native";

type Translate = (
  key: string,
  params?: Record<string, string | number>,
) => string;

const TILES = [0, 1, 2, 3];
const ROWS = [0, 1, 2];

export default function UsageSkeleton({ t }: { t: Translate }) {
  return (
    <View
      accessible
      accessibilityLabel={t("usage.loading")}
      style={styles.wrap}
      testID="usage-skeleton"
    >
      <View style={styles.tiles}>
        {TILES.map((tile) => (
          <View key={tile} style={styles.tile} testID="usage-skeleton-tile" />
        ))}
      </View>
      <View
        accessibilityElementsHidden
        importantForAccessibility="no-hide-descendants"
        style={styles.rows}
        testID="usage-skeleton-rows"
      >
        {ROWS.map((row) => (
          <View key={row} style={styles.bar} testID="usage-skeleton-bar" />
        ))}
      </View>
    </View>
  );
}

const styles = StyleSheet.create({
  /** The settled provider row's box, minus its two lines of text. */
  bar: {
    backgroundColor: "#f4f4f4",
    borderColor: "#e5e5e5",
    borderRadius: 12,
    borderWidth: 1,
    height: 56,
  },
  rows: {
    gap: 8,
  },
  /** `ProviderUsage`'s tile: 47% of the row, same radius and fill. */
  tile: {
    backgroundColor: "#f4f4f4",
    borderRadius: 12,
    flexBasis: "47%",
    flexGrow: 1,
    height: 74,
  },
  tiles: {
    flexDirection: "row",
    flexWrap: "wrap",
    gap: 12,
  },
  wrap: {
    gap: 12,
  },
});
