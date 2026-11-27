import { describe, expect, it, jest } from "@jest/globals";
import { render, within } from "@testing-library/react-native";
import { StyleSheet } from "react-native";
import type {
  ChatItem,
  Turn,
} from "../../../ui/src/components/chat/transcriptProjection";
import type { ThreadState } from "../thread/threadModel";
import { t } from "../i18n";
import ConversationView from "./ConversationView";

/**
 * KIN-MOBILE-002 R4a — block markdown in the real conversation.
 *
 * The phone runs the console's own block parse (`ui/src/lib/markdownBlocks.ts`)
 * rather than a second renderer: a heading is a heading, `- item` lines are a
 * bulleted list, a fenced sample is mono code, `> quote` is a quoted block and
 * `---` is a rule. A message that is only a paragraph stays the single `<Text>`
 * it was, and a table keeps its horizontal scroll.
 */

const TASK_ID = "task-markdown";

function state(turns: Turn[]): ThreadState {
  return {
    taskId: TASK_ID,
    title: "A markdown answer",
    status: "ready",
    turns,
    running: false,
    sendQueue: [],
    banner: null,
    reason: null,
  };
}

function message(key: string, text: string): ChatItem {
  return { kind: "message", key, speaker: "kin", text };
}

function agentTurn(items: ChatItem[]): Turn {
  return { kind: "agent", speaker: "kin", items };
}

const ANSWER = [
  "## 结论",
  "- 一",
  "- 二",
  "```ts",
  "const a = 1;",
  "```",
  "> 引用",
  "---",
  "| 步骤 | 状态 |",
  "| --- | --- |",
  "| 打开 | 完成 |",
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

const onBack = jest.fn();

async function renderView(turns: Turn[]) {
  return render(
    <ConversationView onBack={onBack} state={state(turns)} t={t} />,
  );
}

describe("KIN-MOBILE-002 R4a markdown in the conversation", () => {
  it("KIN-MOBILE-002 R4a: a conversation draws headings, lists, code, quotes and rules as their own elements", async () => {
    const view = await renderView([agentTurn([message("m1", ANSWER)])]);

    expect(view.getByTestId("conversation:md:h2:0").props.accessibilityRole).toBe(
      "header",
    );
    expect(view.getByText("结论")).toBeTruthy();

    expect(view.getByTestId("conversation:md:ul:1")).toBeTruthy();
    expect(view.getByText("一")).toBeTruthy();
    expect(view.getByText("二")).toBeTruthy();

    expect(view.getByTestId("conversation:md:code:2")).toBeTruthy();
    expect(view.getByText("const a = 1;")).toBeTruthy();

    expect(view.getByTestId("conversation:md:quote:3")).toBeTruthy();
    expect(view.getByText("引用")).toBeTruthy();

    expect(view.getByTestId("conversation:md:hr:4")).toBeTruthy();
    expect(view.getByTestId("conversation:md:table:5")).toBeTruthy();
  });

  it("KIN-MOBILE-002 R4a: no raw markdown marker reaches the reader in a rendered message", async () => {
    const view = await renderView([agentTurn([message("m1", ANSWER)])]);

    const drawn = strings(view.toJSON());
    expect(drawn.length).toBeGreaterThan(0);
    for (const text of drawn) {
      expect(text).not.toMatch(/^\s*#{1,3}\s/);
      expect(text).not.toMatch(/^\s*[-*+]\s/);
      expect(text).not.toMatch(/^\s*>\s?/);
      expect(text).not.toContain("```");
      expect(text.trim()).not.toBe("---");
      expect(text).not.toContain("| --- |");
    }
  });

  it("KIN-MOBILE-002 R4a: a message that is only a paragraph still draws the one Text it was", async () => {
    const view = await renderView([agentTurn([message("m1", "只有一段话。")])]);

    const bodies = view.queryAllByTestId(/^conversation:md:/);
    expect(bodies).toHaveLength(1);
    expect(view.getByTestId("conversation:md:p:0")).toBeTruthy();
    expect(view.getByText("只有一段话。")).toBeTruthy();
    // The message style still comes from the view, not from this renderer.
    const style = StyleSheet.flatten(
      view.getByTestId("conversation:md:p:0").props.style,
    );
    expect(style.fontSize).toBe(16);
    expect(style.color).toBe("#1d1d1d");
  });

  it("KIN-MOBILE-002 R4a: a table still scrolls horizontally inside the message", async () => {
    const view = await renderView([agentTurn([message("m1", ANSWER)])]);

    const scroller = view.getByTestId("conversation:table:0");
    expect(scroller.props.horizontal).toBe(true);
    expect(within(scroller).getAllByRole("header")).toHaveLength(2);
  });
});
