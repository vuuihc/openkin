import { beforeEach, describe, expect, it, jest } from "@jest/globals";
import { render } from "@testing-library/react-native";
import {
  Platform,
  StyleSheet,
  useColorScheme,
  type StyleProp,
  type ViewStyle,
} from "react-native";
import type {
  ChatItem,
  Turn,
} from "../../../ui/src/components/chat/transcriptProjection";
import type { Approval } from "../../../ui/src/api/contract";
import type { ThreadState } from "../thread/threadModel";
import { palette } from "../theme/tokens";
import { t } from "../i18n";
import ConversationView from "./ConversationView";
import type { ApprovalsScreenProps } from "./Approvals";

/**
 * KIN-MOBILE-002 R4b — the reading surface's spine, bubble and inline
 * emphasis, drawn in the real conversation.
 *
 * The spine is the phone's signature (DESIGN.md "活动脊"): every agent turn
 * carries a 3pt left edge whose colour is the round's state. The person's own
 * message is a right-aligned blue bubble. Inside an answer the console's
 * inline parse (`ui/src/lib/markdownInline.ts`) draws bold, italic, code and
 * link labels instead of their markers.
 *
 * `useColorScheme` is mocked at the platform module the hook imports, exactly
 * as `theme.test.ts` does, so the two schemes can be read from one render.
 */

jest.mock("react-native/Libraries/Utilities/useColorScheme", () => ({
  __esModule: true,
  default: jest.fn(),
}));

const systemScheme = jest.mocked(useColorScheme) as jest.MockedFunction<
  () => ReturnType<typeof useColorScheme> | undefined
>;

const TASK_ID = "task-visual";
const MONO = Platform.select({ ios: "Menlo", default: "monospace" });

function userTurn(text: string): Turn {
  return {
    kind: "user",
    item: { kind: "message", key: `user-${text}`, speaker: "you", text },
  };
}

function message(key: string, text: string): ChatItem {
  return { kind: "message", key, speaker: "kin", text };
}

function agentTurn(items: ChatItem[]): Turn {
  return { kind: "agent", speaker: "kin", items };
}

function state(turns: Turn[], overrides: Partial<ThreadState> = {}): ThreadState {
  return {
    taskId: TASK_ID,
    title: "一轮对话",
    status: "ready",
    turns,
    running: false,
    sendQueue: [],
    banner: null,
    reason: null,
    ...overrides,
  };
}

function approval(id: string): Approval {
  return {
    id,
    task_id: TASK_ID,
    kind: "tool_use",
    payload: { tool_name: "Bash", input: { command: "npm test" } },
    decision: "pending",
    created_at: 1,
  };
}

function pendingApprovals(): ApprovalsScreenProps {
  return {
    state: {
      status: "ready",
      items: [
        {
          key: "approval:a1",
          kind: "approval",
          id: "a1",
          createdAt: 1,
          approval: approval("a1"),
          phase: "idle",
          pending: true,
        },
      ],
      pendingCount: 1,
      online: true,
      revision: 1,
    },
    t,
    onApprove: jest.fn(),
    onDeny: jest.fn(),
    onAnswer: jest.fn(),
  };
}

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

/** The flattened style a host node paints with. */
function styleOf(node: { props: { style?: unknown } }): Record<string, unknown> {
  const flat = StyleSheet.flatten(node.props.style as StyleProp<ViewStyle>);
  return (flat ?? {}) as Record<string, unknown>;
}

const onBack = jest.fn();

async function renderView(
  turns: Turn[],
  overrides: Partial<ThreadState> = {},
  approvals?: ApprovalsScreenProps,
) {
  return render(
    <ConversationView
      approvals={approvals}
      onBack={onBack}
      state={state(turns, overrides)}
      t={t}
    />,
  );
}

describe("KIN-MOBILE-002 R4b the reading surface", () => {
  beforeEach(() => {
    systemScheme.mockReset();
    systemScheme.mockReturnValue("light");
  });

  it("KIN-MOBILE-002 R4b: the person's message is a right-aligned bubble painted from the scheme", async () => {
    const view = await renderView([
      userTurn("把结论写成三条。"),
      agentTurn([message("m1", "好。")]),
    ]);

    const bubble = styleOf(view.getByTestId("conversation:turn:0"));
    expect(bubble.alignSelf).toBe("flex-end");
    expect(bubble.maxWidth).toBe("82%");
    expect(bubble.borderRadius).toBe(10);
    expect(bubble.paddingHorizontal).toBe(14);
    expect(bubble.paddingVertical).toBe(10);
    expect(bubble.backgroundColor).toBe(palette.light.bubbleUser);

    const ink = styleOf(view.getByText("把结论写成三条。"));
    expect(ink.color).toBe(palette.light.onStatus);
    expect(ink.color).not.toBe(palette.light.text);
  });

  it("KIN-MOBILE-002 R4b: the bubble follows the phone's scheme", async () => {
    systemScheme.mockReturnValue("dark");
    const view = await renderView([
      userTurn("把结论写成三条。"),
      agentTurn([message("m1", "好。")]),
    ]);

    expect(
      styleOf(view.getByTestId("conversation:turn:0")).backgroundColor,
    ).toBe(palette.dark.bubbleUser);
    expect(styleOf(view.getByText("把结论写成三条。")).color).toBe(
      palette.dark.onStatus,
    );
  });

  it("KIN-MOBILE-002 R4b: every agent turn carries a 3pt spine and the running turn is blue", async () => {
    const view = await renderView(
      [
        userTurn("一"),
        agentTurn([message("a1", "第一轮答完了")]),
        userTurn("二"),
        agentTurn([message("a2", "这一轮在做")]),
      ],
      { running: true },
    );

    const first = styleOf(view.getByTestId("conversation:turn:1"));
    expect(first.borderLeftWidth).toBe(3);
    expect(first.paddingLeft).toBe(8);
    expect(first.borderLeftColor).toBe(palette.light.green);

    const last = styleOf(view.getByTestId("conversation:turn:3"));
    expect(last.borderLeftWidth).toBe(3);
    expect(last.paddingLeft).toBe(8);
    expect(last.borderLeftColor).toBe(palette.light.blue);

    // The person's turns are bubbles, not spines.
    expect(styleOf(view.getByTestId("conversation:turn:0")).borderLeftWidth).toBeUndefined();
    expect(styleOf(view.getByTestId("conversation:turn:2")).borderLeftWidth).toBeUndefined();
  });

  it("KIN-MOBILE-002 R4b: a finished turn's spine is green", async () => {
    const view = await renderView([
      userTurn("问"),
      agentTurn([message("m1", "答完了")]),
    ]);

    expect(
      styleOf(view.getByTestId("conversation:turn:1")).borderLeftColor,
    ).toBe(palette.light.green);
  });

  it("KIN-MOBILE-002 R4b: a turn holding an error item has a red spine", async () => {
    const view = await renderView([
      userTurn("问"),
      agentTurn([
        message("m1", "做到一半"),
        { kind: "error", key: "e1", message: "命令失败" },
      ]),
    ]);

    expect(
      styleOf(view.getByTestId("conversation:turn:1")).borderLeftColor,
    ).toBe(palette.light.red);
  });

  it("KIN-MOBILE-002 R4b: a pending approval turns the last agent turn's spine orange", async () => {
    const view = await renderView(
      [userTurn("问"), agentTurn([message("m1", "这一步要你批准")])],
      { running: true },
      pendingApprovals(),
    );

    expect(
      styleOf(view.getByTestId("conversation:turn:1")).borderLeftColor,
    ).toBe(palette.light.orange);
  });

  it("KIN-MOBILE-002 R4b: a standalone error or stopped note draws no spine", async () => {
    const view = await renderView([
      {
        kind: "standalone",
        item: { kind: "error", key: "e1", message: "读取失败" },
      },
      {
        kind: "standalone",
        item: {
          kind: "meta",
          key: "stopped-1",
          label: t("chat.stoppedNote"),
        },
      },
    ]);

    const error = styleOf(view.getByTestId("conversation:turn:0"));
    expect(error.borderLeftWidth).toBeUndefined();
    expect(error.paddingLeft).toBeUndefined();
    const note = styleOf(view.getByTestId("conversation:turn:1"));
    expect(note.borderLeftWidth).toBeUndefined();
    expect(note.paddingLeft).toBeUndefined();
  });

  it("KIN-MOBILE-002 R4b: bold, italic and inline code inside a paragraph draw as emphasis, not markers", async () => {
    const view = await renderView([
      userTurn("问"),
      agentTurn([
        message("m1", "**结论** 是这个 *重点*，跑 `npm test`。"),
      ]),
    ]);

    const strong = styleOf(view.getByText("结论"));
    expect(strong.fontWeight).toBe("700");

    expect(styleOf(view.getByText("重点")).fontStyle).toBe("italic");

    const code = styleOf(view.getByText("npm test"));
    expect(code.fontFamily).toBe(MONO);
    expect(code.backgroundColor).toBe(palette.light.fillStrong);
    expect(code.color).toBe(palette.light.blueInk);

    const drawn = strings(view.toJSON()).join("\n");
    expect(drawn).not.toContain("**");
    expect(drawn).not.toContain("*重点*");
    expect(drawn).not.toContain("`npm test`");
  });

  it("KIN-MOBILE-002 R4b: inline emphasis works inside a bullet list item", async () => {
    const view = await renderView([
      userTurn("问"),
      agentTurn([message("m1", "- 第一 **重点** 项\n- 第二 `npm test` 项")]),
    ]);

    expect(styleOf(view.getByText("重点")).fontWeight).toBe("700");
    const code = styleOf(view.getByText("npm test"));
    expect(code.fontFamily).toBe(MONO);
    expect(code.backgroundColor).toBe(palette.light.fillStrong);
  });

  it("KIN-MOBILE-002 R4b: a fenced code block keeps its asterisks and backticks literal", async () => {
    const literal = "const a = `x`; // **not bold**";
    const view = await renderView([
      userTurn("问"),
      agentTurn([message("m1", ["看样例：", "```", literal, "```"].join("\n"))]),
    ]);

    const code = view.getByText(literal);
    expect(styleOf(code).fontFamily).toBe(MONO);
    expect(styleOf(code).fontWeight).not.toBe("700");
    expect(view.getByTestId("conversation:md:code:1")).toBeTruthy();
  });

  it("KIN-MOBILE-002 R4b: an unmatched ** or backtick stays visible as typed", async () => {
    const typed = "未闭合 **粗体 与 孤立 `反引号";
    const view = await renderView([
      userTurn("问"),
      agentTurn([message("m1", typed)]),
    ]);

    expect(view.getByText(typed)).toBeTruthy();
  });

  it("KIN-MOBILE-002 R4b: a link renders its label in link ink and is not a pressable", async () => {
    const view = await renderView([
      userTurn("问"),
      agentTurn([message("m1", "见 [文档](https://kin.test/doc)。")]),
    ]);

    const label = view.getByText("文档");
    expect(styleOf(label).color).toBe(palette.light.blueInk);
    expect(styleOf(label).textDecorationLine).toBe("underline");
    expect(label.props.onPress).toBeUndefined();
    // No phase of the link is a control: KIN-MOBILE-001 stays as signed.
    expect(view.queryByRole("link")).toBeNull();
  });

  it("KIN-MOBILE-002 R4b: an unsafe link href degrades to a plain label", async () => {
    const view = await renderView([
      userTurn("问"),
      agentTurn([message("m1", "见 [点我](javascript:alert)。")]),
    ]);

    // The label degrades to plain inline text: no nested run, no link ink.
    const paragraph = view.getByTestId("conversation:md:p:0");
    expect(paragraph.props.children).toEqual(["见 ", "点我", "。"]);
    expect(view.queryByRole("link")).toBeNull();
    expect(view.queryByText("javascript:alert")).toBeNull();
  });
});
