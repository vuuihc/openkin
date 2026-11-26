import { describe, expect, it, jest } from "@jest/globals";
import { fireEvent, render } from "@testing-library/react-native";
import type {
  ChatItem,
  ToolStep,
  Turn,
} from "../../../ui/src/components/chat/transcriptProjection";
import type { ThreadState } from "../thread/threadModel";
import { t } from "../i18n";
import ConversationView from "./ConversationView";

/**
 * KIN-MOBILE-001 R4 — the working row while a round has not spoken yet.
 *
 * The signed §4 慢 cell asks the phone to keep what has arrived and draw the
 * activity row; the empty state is 「正在准备」 before the stream starts. This
 * suite pins the one row the phone now draws between a send and the first
 * token, and every moment it must already be gone: the shared
 * `shouldShowGenericThinking` decides, so the phone cannot disagree with the
 * web console about when a round is still silent.
 */

const TASK_ID = "task-thinking";

type ViewProps = Partial<Parameters<typeof ConversationView>[0]>;

function state(
  turns: Turn[],
  overrides: Partial<ThreadState> = {},
): ThreadState {
  return {
    taskId: TASK_ID,
    title: "A conversation",
    status: "ready",
    turns,
    running: false,
    sendQueue: [],
    banner: null,
    reason: null,
    ...overrides,
  };
}

/**
 * The shared projection stamps a person's message `speaker: "user"` — the
 * round boundary `shouldShowGenericThinking` scans back to. A fixture that said
 * "you" would hide the boundary and make the previous round's answer look like
 * this round's content.
 */
function userTurn(text: string): Turn {
  return {
    kind: "user",
    item: { kind: "message", key: `user-${text}`, speaker: "user", text },
  };
}

function answerTurn(text: string): Turn {
  return {
    kind: "agent",
    speaker: "kin",
    items: [{ kind: "message", key: `answer-${text}`, speaker: "kin", text }],
  };
}

function toolStep(key: string): ToolStep {
  return {
    kind: "tool",
    key,
    speaker: "kin",
    name: "bash",
    summary: "checking the suite",
    status: "running",
  };
}

function progressItem(steps: ToolStep[]): ChatItem {
  return {
    kind: "progress",
    key: `progress-${steps.map((step) => step.key).join("-")}`,
    speaker: "kin",
    steps,
  };
}

const onBack = jest.fn();

function element(turns: Turn[], extra: ViewProps = {}) {
  return (
    <ConversationView onBack={onBack} state={state(turns)} t={t} {...extra} />
  );
}

async function renderView(turns: Turn[], extra: ViewProps = {}) {
  return render(element(turns, extra));
}

describe("KIN-MOBILE-001 R4 the thinking row", () => {
  it("KIN-MOBILE-001 R4: an open round with no agent content yet draws the thinking row", async () => {
    const view = await renderView([userTurn("在吗")], {
      state: state([userTurn("在吗")], { running: true }),
    });

    const row = view.getByTestId("conversation:thinking");
    expect(row).toBeTruthy();
    expect(view.getByText(t("chat.thinking"))).toBeTruthy();
  });

  it("KIN-MOBILE-001 R4: the first token takes the thinking row away", async () => {
    const turns = [userTurn("在吗"), answerTurn("在的，我看一下。")];
    const view = await renderView(turns, {
      state: state(turns, { running: true }),
    });

    expect(view.getByText("在的，我看一下。")).toBeTruthy();
    expect(view.queryByTestId("conversation:thinking")).toBeNull();
    expect(view.queryByText(t("chat.thinking"))).toBeNull();
  });

  it("KIN-MOBILE-001 R4: a tool row in the current round takes the thinking row away", async () => {
    const tool: Turn = {
      kind: "agent",
      speaker: "kin",
      items: [progressItem([toolStep("call-1")])],
    };
    const turns = [userTurn("跑一下测试"), tool];
    const view = await renderView(turns, {
      state: state(turns, { running: true }),
    });

    expect(view.getByTestId("conversation:tool:call-1")).toBeTruthy();
    expect(view.queryByTestId("conversation:thinking")).toBeNull();
  });

  it("KIN-MOBILE-001 R4: a settled conversation draws no thinking row", async () => {
    const turns = [userTurn("在吗"), answerTurn("在的。")];
    const view = await renderView(turns);

    expect(view.getByText("在的。")).toBeTruthy();
    expect(view.queryByTestId("conversation:thinking")).toBeNull();
  });

  it("KIN-MOBILE-001 R4: the previous round's answer is not the new round's cue", async () => {
    const turns = [
      userTurn("first question"),
      answerTurn("the previous answer"),
      userTurn("second question"),
    ];
    const view = await renderView(turns, {
      state: state(turns, { running: true }),
    });

    expect(view.getByText("the previous answer")).toBeTruthy();
    expect(view.getByTestId("conversation:thinking")).toBeTruthy();
  });

  it("KIN-MOBILE-001 R4: the first load's skeleton is the only cue", async () => {
    // A task the list already knows is running, whose transcript has not
    // arrived: the skeleton owns this moment, so the row waits with it.
    const view = await renderView([], {
      state: state([], { status: "loading", running: true }),
    });

    expect(view.getByTestId("conversation-skeleton")).toBeTruthy();
    expect(view.queryByTestId("conversation:thinking")).toBeNull();
    expect(view.queryByText(t("chat.thinking"))).toBeNull();
  });

  it("KIN-MOBILE-001 R4: the thinking row is a polite status, not a control", async () => {
    const view = await renderView([userTurn("在吗")], {
      state: state([userTurn("在吗")], { running: true }),
    });

    const row = view.getByTestId("conversation:thinking");
    expect(row.props.accessibilityLiveRegion).toBe("polite");
    expect(row.props.accessibilityLabel).toBe(t("chat.thinking"));
    // Nothing to press: no button role, no press handler.
    expect(row.props.accessibilityRole).toBeUndefined();
    expect(row.props.onPress).toBeUndefined();
    await fireEvent.press(row);
    expect(onBack).not.toHaveBeenCalled();
  });

  it("KIN-MOBILE-001 R4: the thinking row never takes the composer's place", async () => {
    const onSend = jest.fn();
    const view = await renderView([userTurn("在吗")], {
      onSend,
      state: state([userTurn("在吗")], { running: true }),
    });

    expect(view.getByTestId("conversation:thinking")).toBeTruthy();
    expect(view.getByTestId("conversation:composer")).toBeTruthy();
    expect(view.getByTestId("conversation:send")).toBeTruthy();
  });
});
