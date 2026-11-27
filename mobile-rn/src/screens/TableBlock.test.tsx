import { describe, expect, it } from "@jest/globals";
import { render } from "@testing-library/react-native";
import { StyleSheet } from "react-native";
import { MessageBody } from "./MarkdownBody";

/**
 * KIN-MOBILE-001 R4 — how one table is drawn on the phone.
 *
 * The web keeps a table at its natural width and lets the wrapper scroll
 * (`ui/src/components/Markdown.tsx:81-86`); the phone's equivalent is a
 * horizontal ScrollView whose cells are never told to shrink, so a table
 * wider than 390 scrolls instead of squeezing its first column. The header
 * row is exposed as headers so a screen reader announces the column, and no
 * raw pipe or divider rule is ever drawn.
 */

const MESSAGE = [
  "依次执行：",
  "| 步骤 | 状态 |",
  "| --- | --- |",
  "| 打开 | 完成 |",
  "以上。",
].join("\n");

function strings(node: unknown, out: string[] = []): string[] {
  if (typeof node === "string") {
    out.push(node);
  } else if (Array.isArray(node)) {
    for (const child of node) strings(child, out);
  } else if (node && typeof node === "object") {
    const children = (node as { children?: unknown }).children;
    if (children !== undefined) strings(children, out);
  }
  return out;
}

describe("KIN-MOBILE-001 R4 drawing a table", () => {
  it("KIN-MOBILE-001 R4: the table scrolls horizontally inside its own row", async () => {
    const view = await render(<MessageBody text={MESSAGE} textStyle={{ fontSize: 16 }} />);

    const scroller = view.getByTestId("conversation:table:0");
    expect(scroller.props.horizontal).toBe(true);

    // Natural width: a cell keeps its own size instead of being squeezed to
    // the 390pt measure, which is what made a column unreadable.
    const cell = StyleSheet.flatten(view.getByText("打开").props.style);
    expect(cell.flex).toBeUndefined();
    expect(cell.width).not.toBe("100%");
    expect(cell.flexShrink).toBe(0);
  });

  it("KIN-MOBILE-001 R4: every header cell is exposed as a header and every body cell reads its own text", async () => {
    const view = await render(<MessageBody text={MESSAGE} textStyle={{ fontSize: 16 }} />);

    const headers = view.getAllByRole("header");
    expect(headers).toHaveLength(2);
    expect(headers[0].props.children).toBe("步骤");
    expect(headers[1].props.children).toBe("状态");

    // Each body cell is its own Text, so VoiceOver reads the value with the
    // column it belongs to rather than one flattened line.
    expect(view.getByText("打开")).toBeTruthy();
    expect(view.getByText("完成")).toBeTruthy();
  });

  it("KIN-MOBILE-001 R4: no rendered text contains a raw pipe or a divider rule", async () => {
    const view = await render(<MessageBody text={MESSAGE} textStyle={{ fontSize: 16 }} />);

    const drawn = strings(view.toJSON());
    expect(drawn.length).toBeGreaterThan(0);
    for (const text of drawn) {
      expect(text).not.toContain("|");
      expect(text.trim()).not.toMatch(/^:?-+:?$/);
    }
  });

  it("KIN-MOBILE-001 R4: paragraphs on both sides of a table keep their order and text", async () => {
    const view = await render(<MessageBody text={MESSAGE} textStyle={{ fontSize: 16 }} />);

    expect(view.getByText("依次执行：")).toBeTruthy();
    expect(view.getByText("以上。")).toBeTruthy();

    const order = strings(view.toJSON());
    expect(order.indexOf("依次执行：")).toBeLessThan(order.indexOf("步骤"));
    expect(order.indexOf("步骤")).toBeLessThan(order.indexOf("以上。"));
  });
});
