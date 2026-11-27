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
 * message is a right-aligned blue bubble, and inline bold, italic, code and
 * link labels come from the console's shared inline parse.
 *
 * `useColorScheme` is mocked at the platform module the hook imports, as
 * `theme.test.ts` does. A case reads one scheme per render.
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

const userTurn = (text: string): Turn => ({
  kind: "user",
  item: { kind: "message", key: `user-${text}`, speaker: "you", text },
});
const message = (key: string, text: string): ChatItem => ({
  kind: "message",
  key,
  speaker: "kin",
  text,
});
const agentTurn = (...items: ChatItem[]): Turn => ({
  kind: "agent",
  speaker: "kin",
  items,
});

function pendingApprovals(): ApprovalsScreenProps {
  const approval = {
    id: "a1",
    task_id: TASK_ID,
    kind: "tool_use",
    payload: { tool_name: "Bash", input: { command: "npm test" } },
    decision: "pending",
    created_at: 1,
  } as Approval;
  return {
    state: {
      status: "ready",
      items: [
        { key: "a1", kind: "approval", id: "a1", createdAt: 1, approval, phase: "idle", pending: true },
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
      state={{
        taskId: TASK_ID,
        title: "一轮对话",
        status: "ready",
        turns,
        running: false,
        sendQueue: [],
        banner: null,
        reason: null,
        ...overrides,
      }}
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
    const light = await renderView([userTurn("把结论写成三条。")]);

    expect(styleOf(light.getByTestId("conversation:turn:0"))).toMatchObject({
      alignSelf: "flex-end",
      backgroundColor: palette.light.bubbleUser,
      borderRadius: 10,
      maxWidth: "82%",
      paddingHorizontal: 14,
      paddingVertical: 10,
    });
    const ink = styleOf(light.getByText("把结论写成三条。"));
    expect(ink.color).toBe(palette.light.onBrand);
    expect(ink.color).not.toBe(palette.light.text);

    // The same bubble under a dark phone reads the dark scheme's blue.
    systemScheme.mockReturnValue("dark");
    const dark = await renderView([userTurn("把结论写成三条。")]);
    expect(styleOf(dark.getByTestId("conversation:turn:0")).backgroundColor).toBe(
      palette.dark.bubbleUser,
    );
    expect(styleOf(dark.getByText("把结论写成三条。")).color).toBe(
      palette.dark.onBrand,
    );
  });

  it("KIN-MOBILE-002 R4b: every agent turn carries a 3pt spine and the running turn is blue", async () => {
    const view = await renderView(
      [
        userTurn("一"),
        agentTurn(message("a1", "第一轮答完了")),
        userTurn("二"),
        agentTurn(message("a2", "这一轮在做")),
      ],
      { running: true },
    );

    expect(styleOf(view.getByTestId("conversation:turn:1"))).toMatchObject({
      borderLeftColor: palette.light.green,
      borderLeftWidth: 3,
      paddingLeft: 8,
    });
    expect(styleOf(view.getByTestId("conversation:turn:3"))).toMatchObject({
      borderLeftColor: palette.light.blue,
      borderLeftWidth: 3,
      paddingLeft: 8,
    });
    // The person's turns are bubbles, not spines.
    expect(styleOf(view.getByTestId("conversation:turn:0")).borderLeftWidth).toBeUndefined();
    expect(styleOf(view.getByTestId("conversation:turn:2")).borderLeftWidth).toBeUndefined();
  });

  it("KIN-MOBILE-002 R4b: a finished turn's spine is green, a turn holding an error item is red", async () => {
    const view = await renderView([
      userTurn("一"),
      agentTurn(message("a1", "答完了")),
      userTurn("二"),
      agentTurn(message("a2", "做到一半"), {
        kind: "error",
        key: "e1",
        message: "命令失败",
      }),
    ]);

    expect(styleOf(view.getByTestId("conversation:turn:1")).borderLeftColor).toBe(
      palette.light.green,
    );
    expect(styleOf(view.getByTestId("conversation:turn:3")).borderLeftColor).toBe(
      palette.light.red,
    );
  });

  it("KIN-MOBILE-002 R4b: a newer ask leaves the old answer done, while its stopped note stays red", async () => {
    const waiting = await renderView(
      [
        userTurn("一"),
        agentTurn(message("a1", "上一轮答完了")),
        userTurn("二"),
      ],
      { running: true },
    );

    expect(
      styleOf(waiting.getByTestId("conversation:turn:1")).borderLeftColor,
    ).toBe(palette.light.green);

    const stopped = await renderView(
      [
        userTurn("一"),
        agentTurn(message("a2", "做到一半"), {
          kind: "meta",
          key: "stopped-1",
          label: t("chat.stoppedNote"),
        }),
        userTurn("二"),
      ],
      { running: true },
    );

    expect(
      styleOf(stopped.getByTestId("conversation:turn:1")).borderLeftColor,
    ).toBe(palette.light.red);
  });

  it("KIN-MOBILE-002 R4b: a pending approval turns the last agent turn's spine orange", async () => {
    const view = await renderView([agentTurn(message("m1", "这一步要你批准"))], {
      running: true,
    }, pendingApprovals());

    expect(styleOf(view.getByTestId("conversation:turn:0")).borderLeftColor).toBe(
      palette.light.orange,
    );
  });

  it("KIN-MOBILE-002 R4b: a standalone error or stopped note draws no spine", async () => {
    const view = await renderView([
      { kind: "standalone", item: { kind: "error", key: "e1", message: "读取失败" } },
      {
        kind: "standalone",
        item: { kind: "meta", key: "stopped-1", label: t("chat.stoppedNote") },
      },
    ]);

    for (const id of ["conversation:turn:0", "conversation:turn:1"]) {
      const style = styleOf(view.getByTestId(id));
      expect(style.borderLeftWidth).toBeUndefined();
      expect(style.paddingLeft).toBeUndefined();
    }
  });

  it("KIN-MOBILE-002 R4b: bold, italic and inline code inside a paragraph draw as emphasis, not markers", async () => {
    const view = await renderView([
      agentTurn(message("m1", "**结论** 是这个 *重点*，跑 `npm test`。")),
    ]);

    expect(styleOf(view.getByText("结论")).fontWeight).toBe("700");
    expect(styleOf(view.getByText("重点")).fontStyle).toBe("italic");
    expect(styleOf(view.getByText("npm test"))).toMatchObject({
      backgroundColor: palette.light.fillStrong,
      color: palette.light.blueInk,
      fontFamily: MONO,
    });
    // The source with its markers reaches no text node.
    expect(
      view.queryByText("**结论** 是这个 *重点*，跑 `npm test`。"),
    ).toBeNull();
  });
  it("KIN-MOBILE-002 R4b: inline emphasis works inside a bullet list item", async () => {
    const view = await renderView([
      agentTurn(message("m1", "- 第一 **重点** 项\n- 第二 `npm test` 项")),
    ]);

    expect(styleOf(view.getByText("重点")).fontWeight).toBe("700");
    expect(styleOf(view.getByText("npm test"))).toMatchObject({
      backgroundColor: palette.light.fillStrong,
      fontFamily: MONO,
    });
  });

  it("KIN-MOBILE-002 R4b: a fenced code block keeps its asterisks and backticks literal", async () => {
    const literal = "const a = `x`; // **not bold**";
    const view = await renderView([
      agentTurn(message("m1", ["看样例：", "```", literal, "```"].join("\n"))),
    ]);

    expect(styleOf(view.getByText(literal)).fontFamily).toBe(MONO);
    expect(styleOf(view.getByText(literal)).fontWeight).not.toBe("700");
    expect(view.getByTestId("conversation:md:code:1")).toBeTruthy();
  });

  it("KIN-MOBILE-002 R4b: an unmatched ** or backtick stays visible as typed", async () => {
    const typed = "未闭合 **粗体 与 孤立 `反引号";
    const view = await renderView([agentTurn(message("m1", typed))]);

    expect(view.getByText(typed)).toBeTruthy();
  });

  it("KIN-MOBILE-002 R4b: a link renders its label in link ink and is not a pressable", async () => {
    const view = await renderView([
      agentTurn(
        message("m1", "见 [文档](https://kin.test/doc) 与 [点我](javascript:alert)。"),
      ),
    ]);

    const label = view.getByText("文档");
    expect(styleOf(label)).toMatchObject({
      color: palette.light.blueInk,
      textDecorationLine: "underline",
    });
    expect(label.props.onPress).toBeUndefined();
    // No phase of the link is a control: KIN-MOBILE-001 stays as signed.
    expect(view.queryByRole("link")).toBeNull();
    // An unsafe href degrades to plain inline text: no nested run, no ink.
    expect(view.getByTestId("conversation:md:p:0").props.children).toEqual([
      "见 ",
      expect.anything(),
      " 与 ",
      "点我",
      "。",
    ]);
  });
});
