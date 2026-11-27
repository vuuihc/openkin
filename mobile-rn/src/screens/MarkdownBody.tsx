/**
 * KIN-MOBILE-002 R4a/R4b — one agent message, drawn block by block.
 *
 * The blocks come from the console's own parse (`ui/src/lib/markdownBlocks.ts`,
 * imported by relative path) rather than a second implementation: a heading is
 * a heading, `- item` lines are a list, a fenced sample is mono code, `> quote`
 * is a quoted block and `---` is a 1pt rule. A message that is only a paragraph
 * is still the one `<Text>` the view drew before this module existed.
 *
 * No colour is written here. Sizes and weights are local; every colour comes
 * from the view's `textStyle` or from the `styles` prop, which
 * `ConversationView` builds from its own literals (the token layer, R1b,
 * takes them over).
 *
 * R4b: inline runs come from the console's other parse
 * (`ui/src/lib/markdownInline.ts`) — bold, italic, code and a link's label
 * draw as emphasis instead of their markers. A fenced block and a table cell
 * stay literal: a sample is text, not prose.
 */

import { useMemo, type ReactNode } from "react";
import {
  Platform,
  StyleSheet,
  Text,
  View,
  type StyleProp,
  type TextStyle,
} from "react-native";
import { splitBlocks, type Block } from "../../../ui/src/lib/markdownBlocks";
import { inlineTokens } from "../../../ui/src/lib/markdownInline";
import { TableBlock } from "./TableBlock";

/** The colours this renderer needs and does not own. */
export type MessageBodyStyles = {
  /** The 1pt rule under an `---` and the quote's left bar. */
  hairline?: string;
  /** Behind a fenced code sample. */
  codeBackground?: string;
  /** Behind an inline code run. */
  fillStrong?: string;
  /** An inline code run's ink and a link's label. */
  blueInk?: string;
};

export type MessageBodyProps = {
  text: string;
  /** The view's message style; a message with no block syntax is one such Text. */
  textStyle?: StyleProp<TextStyle>;
  /** Colours built by the view; never written in this file. */
  styles?: MessageBodyStyles;
};

const MONO = Platform.select({ ios: "Menlo", default: "monospace" });

/**
 * One text run as nested `<Text>`: strong is bold, em is italic, code is a
 * mono run on the fill, a link's label takes link ink and an underline. No
 * inline syntax returns the bare string, so the common case is untouched.
 */
function inlineChildren(
  text: string,
  styles: MessageBodyStyles | undefined,
): ReactNode {
  const tokens = inlineTokens(text);
  if (tokens.length === 1 && tokens[0]!.kind === "text") {
    return tokens[0]!.value;
  }
  return tokens.map((token, i) => {
    switch (token.kind) {
      case "strong":
        return <Text key={i} style={sheet.strong}>{token.value}</Text>;
      case "em":
        return <Text key={i} style={sheet.em}>{token.value}</Text>;
      case "code":
        return (
          <Text
            key={i}
            style={[
              sheet.inlineCode,
              { backgroundColor: styles?.fillStrong, color: styles?.blueInk },
            ]}
          >
            {token.value}
          </Text>
        );
      case "link":
        if (token.href === undefined) return token.value;
        return (
          <Text key={i} style={[sheet.link, { color: styles?.blueInk }]}>
            {token.value}
          </Text>
        );
      default:
        return token.value;
    }
  });
}

export function MessageBody({ text, textStyle, styles }: MessageBodyProps) {
  const blocks = useMemo(() => splitBlocks(text), [text]);

  // The common case: no block syntax at all. Draw the one `<Text>` the view
  // drew before, so a plain answer paints exactly as it did.
  if (blocks.length === 0) return <Text style={textStyle} />;
  if (blocks.length === 1 && blocks[0].type === "p") {
    return (
      <Text style={textStyle} testID="conversation:md:p:0">
        {inlineChildren(blocks[0].value, styles)}
      </Text>
    );
  }

  let tableIndex = 0;
  return (
    <View style={sheet.body}>
      {blocks.map((block, i) => {
        if (block.type === "p") {
          return (
            <Text
              key={i}
              style={textStyle}
              testID={`conversation:md:p:${i}`}
            >
              {inlineChildren(block.value, styles)}
            </Text>
          );
        }
        if (block.type === "h1" || block.type === "h2" || block.type === "h3") {
          return (
            <Text
              accessibilityRole="header"
              key={i}
              style={[textStyle, HEADING[block.type]]}
              testID={`conversation:md:${block.type}:${i}`}
            >
              {inlineChildren(block.value, styles)}
            </Text>
          );
        }
        if (block.type === "ul" || block.type === "ol") {
          return (
            <View key={i} testID={`conversation:md:${block.type}:${i}`}>
              {block.items.map((item, j) => (
                <View key={j} style={sheet.listRow}>
                  <Text style={[textStyle, sheet.marker]}>
                    {block.type === "ul" ? "•" : `${j + 1}.`}
                  </Text>
                  <Text style={[textStyle, sheet.listItem]}>
                    {inlineChildren(item, styles)}
                  </Text>
                </View>
              ))}
            </View>
          );
        }
        if (block.type === "code") {
          return (
            <View
              key={i}
              style={[sheet.code, { backgroundColor: styles?.codeBackground }]}
              testID={`conversation:md:code:${i}`}
            >
              <Text style={[textStyle, sheet.codeText]}>{block.value}</Text>
            </View>
          );
        }
        if (block.type === "quote") {
          return (
            <View
              key={i}
              style={[sheet.quote, { borderLeftColor: styles?.hairline }]}
              testID={`conversation:md:quote:${i}`}
            >
              {block.lines.map((line, j) => (
                <Text key={j} style={[textStyle, sheet.quoteText]}>
                  {inlineChildren(line, styles)}
                </Text>
              ))}
            </View>
          );
        }
        if (block.type === "hr") {
          return (
            <View
              key={i}
              style={[sheet.hr, { backgroundColor: styles?.hairline }]}
              testID={`conversation:md:hr:${i}`}
            />
          );
        }
        if (block.type === "table") {
          return (
            <View key={i} testID={`conversation:md:table:${i}`}>
              <TableBlock
                header={block.header}
                index={tableIndex++}
                rows={block.rows}
              />
            </View>
          );
        }
        return null;
      })}
    </View>
  );
}

const HEADING: Record<"h1" | "h2" | "h3", TextStyle> = {
  h1: { fontSize: 20, fontWeight: "700" },
  h2: { fontSize: 18, fontWeight: "600" },
  h3: { fontSize: 16, fontWeight: "600" },
};

const sheet = StyleSheet.create({
  body: {
    gap: 8,
  },
  code: {
    borderRadius: 6,
    padding: 10,
  },
  codeText: {
    fontFamily: MONO,
    fontSize: 14,
  },
  em: {
    fontStyle: "italic",
  },
  hr: {
    height: 1,
  },
  inlineCode: {
    // A touch under the body size, as the console's code run is: mono at the
    // body's own size reads larger than the prose around it.
    fontFamily: MONO,
    fontSize: 15,
  },
  link: {
    textDecorationLine: "underline",
  },
  listItem: {
    flexShrink: 1,
  },
  listRow: {
    flexDirection: "row",
  },
  marker: {
    width: 20,
  },
  quote: {
    borderLeftWidth: 2,
    gap: 4,
    paddingLeft: 10,
  },
  quoteText: {
    fontStyle: "italic",
  },
  strong: {
    fontWeight: "700",
  },
});
