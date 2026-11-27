/**
 * KIN-MOBILE-001 R4 — a markdown table in an agent message, drawn as a table.
 *
 * The web's table sits at its natural width inside a scrolling wrapper
 * (`ui/src/components/Markdown.tsx:81-86`) because squeezing it to the prose
 * measure wrapped the first column one character per line. RN has the same
 * shape: a horizontal `ScrollView` whose cells are never told to shrink.
 *
 * React Native has no table layout, so a row's cells would each size to their
 * own text and the columns would not line up. `columnWidths` gives every cell
 * in a column one width, taken from that column's longest value, capped so a
 * runaway cell wraps instead of pushing the table metres wide. That is what
 * makes a column a column without measuring the laid-out text.
 */

import { useMemo } from "react";
import {
  ScrollView,
  StyleSheet,
  Text,
  View,
} from "react-native";
import { useTheme } from "../theme/useTheme";
import type { Palette } from "../theme/tokens";

/** Room for a cell's padding plus a little breathing space. */
const CELL_CHROME = 24;
/** One character at the cell's 14pt, in points. */
const CHAR_WIDTH = 8;
const MIN_CELL_WIDTH = 72;
const MAX_CELL_WIDTH = 240;

function columnWidths(header: string[], rows: string[][]): number[] {
  return header.map((cell, column) => {
    let longest = cell.length;
    for (const row of rows) {
      longest = Math.max(longest, (row[column] ?? "").length);
    }
    return Math.min(
      MAX_CELL_WIDTH,
      Math.max(MIN_CELL_WIDTH, longest * CHAR_WIDTH + CELL_CHROME),
    );
  });
}

export type TableBlockProps = {
  header: string[];
  rows: string[][];
  /** This table's index among its message's tables (the testID suffix). */
  index: number;
};

export function TableBlock({ header, rows, index }: TableBlockProps) {
  const { colors } = useTheme();
  const styles = useMemo(() => makeStyles(colors), [colors]);
  const widths = columnWidths(header, rows);
  return (
    <ScrollView
      horizontal
      showsHorizontalScrollIndicator
      style={styles.scroller}
      testID={`conversation:table:${index}`}
    >
      <View style={styles.table}>
        <View style={[styles.row, styles.headerRow]}>
          {header.map((cell, column) => (
            <Text
              accessibilityRole="header"
              key={column}
              style={[styles.cell, styles.headerCell, { width: widths[column] }]}
            >
              {cell}
            </Text>
          ))}
        </View>
        {rows.map((row, rowIndex) => (
          <View key={rowIndex} style={styles.row}>
            {row.map((cell, column) => (
              <Text
                key={column}
                style={[styles.cell, { width: widths[column] }]}
              >
                {cell}
              </Text>
            ))}
          </View>
        ))}
      </View>
    </ScrollView>
  );
}

const makeStyles = (colors: Palette) => StyleSheet.create({
  cell: {
    color: colors.secondary,
    flexShrink: 0,
    fontSize: 14,
    paddingHorizontal: 12,
    paddingVertical: 8,
  },
  headerCell: {
    color: colors.text,
    fontWeight: "600",
  },
  headerRow: {
    backgroundColor: colors.fill,
  },
  row: {
    borderBottomColor: colors.hairlineStrong,
    borderBottomWidth: StyleSheet.hairlineWidth,
    flexDirection: "row",
  },
  scroller: {
    flexGrow: 0,
  },
  table: {
    borderColor: colors.hairlineStrong,
    borderRadius: 8,
    borderWidth: StyleSheet.hairlineWidth,
    overflow: "hidden",
  },
});
