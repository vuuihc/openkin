import { describe, expect, it, jest } from "@jest/globals";
import { render, within } from "@testing-library/react-native";
import type {
  ChatItem,
  ToolStep,
  Turn,
} from "../../../ui/src/components/chat/transcriptProjection";
import type { ThreadState } from "../thread/threadModel";
import { t } from "../i18n";
import ConversationView from "./ConversationView";

/**
 * KIN-MOBILE-001 R4 — a table inside the real conversation.
 *
 * Only message items route through the table renderer
 * (`ConversationView.tsx` `TurnBlock`); a meta line, an error or a tool row is
 * exactly the `<Text>` it was, so the rest of the transcript does not move.
 */

const TASK_ID = "task-table";

function state(turns: Turn[]): ThreadState {
  return {
    taskId: TASK_ID,
    title: "A table answer",
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

function meta(key: string, label: string): ChatItem {
  return { kind: "meta", key, label };
}

function agentTurn(items: ChatItem[]): Turn {
  return { kind: "agent", speaker: "kin", items };
}

function toolStep(): ToolStep {
  return {
    kind: "tool",
    key: "call-1",
    speaker: "kin",
    name: "bash",
    summary: "checking the suite",
    status: "done",
    input: { command: "npm test" },
    output: "all green",
  };
}

const ANSWER = [
  "跑完的结果如下：",
  "| 步骤 | 状态 |",
  "| --- | --- |",
  "| 打开 | 完成 |",
  "全部通过。",
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

describe("KIN-MOBILE-001 R4 a table in the conversation", () => {
  it("KIN-MOBILE-001 R4: an agent answer draws its table and the paragraphs around it", async () => {
    const view = await renderView([agentTurn([message("m1", ANSWER)])]);

    expect(view.getByTestId("conversation:table:0").props.horizontal).toBe(true);
    // Scoped to the table: the screen title is a third header.
    expect(
      within(view.getByTestId("conversation:table:0")).getAllByRole("header"),
    ).toHaveLength(2);
    expect(view.getByText("跑完的结果如下：")).toBeTruthy();
    expect(view.getByText("全部通过。")).toBeTruthy();
  });

  it("KIN-MOBILE-001 R4: a tool row and a meta row beside a table are unchanged", async () => {
    const view = await renderView([
      agentTurn([
        message("m1", ANSWER),
        meta("m2", "used 3 tools"),
        {
          kind: "progress",
          key: "call-1",
          speaker: "kin",
          steps: [toolStep()],
        },
      ]),
    ]);

    // The table is there, and the two non-message items keep their own shapes.
    expect(view.getByTestId("conversation:table:0")).toBeTruthy();
    expect(view.getByText("used 3 tools")).toBeTruthy();
    const tool = view.getByTestId("conversation:tool:call-1");
    expect(tool.props.accessibilityRole).toBe("button");
    expect(tool.props.accessibilityState).toEqual({ expanded: false });
  });

  it("KIN-MOBILE-001 R4: an error item that contains pipes stays one plain text item", async () => {
    const error = "| code | detail |\n| --- | --- |\n| E1 | failed |";
    const view = await renderView([
      agentTurn([{ kind: "error", key: "e1", message: error }]),
    ]);

    expect(view.queryAllByTestId(/^conversation:table:/)).toHaveLength(0);
    expect(strings(view.toJSON())).toContain(error);
  });
});
