/**
 * KIN-MOBILE-001 R4 — a markdown table in an agent message, drawn as a table.
 *
 * The web's table sits at its natural width inside a scrolling wrapper
 * (`ui/src/components/Markdown.tsx:82-85`) because squeezing it to the prose
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
  type StyleProp,
  type TextStyle,
} from "react-native";
import { splitTableBlocks } from "../thread/tableBlock";

/** Room for a cell's padding plus a little breathing space. */
const CELL_CHROME = 24;
/** One character at the cell's 14pt, in points. */
const CHAR_WIDTH = 8;
const MIN_CELL_WIDTH = 72;
const MAX_CELL_WIDTH = 240;

const BORDER = "#dcdcdc";

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

export type MessageBodyProps = {
  text: string;
  /** The view's message style; a message with no table is one such Text. */
  textStyle?: StyleProp<TextStyle>;
};

/**
 * One agent message: its paragraphs and, where the text holds a table, the
 * table. A message with no table is the single `<Text>` the view drew before
 * this row, so the common case paints exactly as it did.
 */
export function MessageBody({ text, textStyle }: MessageBodyProps) {
  const blocks = useMemo(() => splitTableBlocks(text), [text]);

  if (blocks.length === 1 && blocks[0].kind === "text") {
    return <Text style={textStyle}>{blocks[0].text}</Text>;
  }

  let tableIndex = 0;
  return (
    <View style={styles.body}>
      {blocks.map((block, i) =>
        block.kind === "text" ? (
          <Text key={i} style={textStyle}>
            {block.text}
          </Text>
        ) : (
          <TableBlock
            header={block.header}
            index={tableIndex++}
            key={i}
            rows={block.rows}
          />
        ),
      )}
    </View>
  );
}

const styles = StyleSheet.create({
  body: {
    gap: 8,
  },
  cell: {
    color: "#3a3a3a",
    flexShrink: 0,
    fontSize: 14,
    paddingHorizontal: 12,
    paddingVertical: 8,
  },
  headerCell: {
    color: "#1d1d1d",
    fontWeight: "600",
  },
  headerRow: {
    backgroundColor: "#f2f2f2",
  },
  row: {
    borderBottomColor: BORDER,
    borderBottomWidth: StyleSheet.hairlineWidth,
    flexDirection: "row",
  },
  scroller: {
    flexGrow: 0,
  },
  table: {
    borderColor: BORDER,
    borderRadius: 8,
    borderWidth: StyleSheet.hairlineWidth,
    overflow: "hidden",
  },
});
