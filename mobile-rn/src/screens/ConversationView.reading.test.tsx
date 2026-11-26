import { describe, expect, it, jest } from "@jest/globals";
import { fireEvent, render } from "@testing-library/react-native";
import { FlatList, StyleSheet } from "react-native";
import type {
  ChatItem,
  ProgressItem,
  ToolStep,
  Turn,
} from "../../../ui/src/components/chat/transcriptProjection";
import type { ThreadState } from "../thread/threadModel";
import { t } from "../i18n";
import ConversationView from "./ConversationView";

/**
 * KIN-MOBILE-001 R4c — reading a long conversation on the phone.
 *
 * The shared projection is proven elsewhere; this suite is about the reading
 * surface the signed story asks for: the thread opens at its last segment, the
 * stream may move the page only while the reader is at the end, a tool row is
 * a real 44pt control that says its status and can show what it recorded, and
 * a long thread is virtualized instead of mounting every turn.
 *
 * Layout is absent under the test renderer, so the cases fire the scroll and
 * content-size events the platform would: `scrollToEnd` is the assertion, and
 * the follow policy is exercised through the same handler the device uses.
 */

const TASK_ID = "task-reading";
const VIEWPORT_HEIGHT = 800;

type ViewProps = Partial<Parameters<typeof ConversationView>[0]>;
type View = Awaited<ReturnType<typeof render>>;

function state(turns: Turn[], overrides: Partial<ThreadState> = {}): ThreadState {
  return {
    taskId: TASK_ID,
    title: "Morning planning",
    status: "ready",
    turns,
    running: false,
    sendQueue: [],
    banner: null,
    reason: null,
    ...overrides,
  };
}

function userTurn(text: string): Turn {
  return {
    kind: "user",
    item: { kind: "message", key: `user-${text}`, speaker: "you", text },
  };
}

function toolStep(overrides: Partial<ToolStep> = {}): ToolStep {
  return {
    kind: "tool",
    key: "call-1",
    speaker: "kin",
    name: "bash",
    summary: "checking the suite",
    status: "done",
    input: { command: "npm test" },
    output: "all green",
    ...overrides,
  };
}

function toolCard(key: string, steps: ToolStep[]): ProgressItem {
  return { kind: "progress", key, speaker: "kin", steps };
}

function noteCard(key: string, text: string): ProgressItem {
  return {
    kind: "progress",
    key,
    speaker: "kin",
    prose: true,
    steps: [
      {
        kind: "note",
        key,
        speaker: "kin",
        text,
        status: "running",
        source: "reasoning",
      },
    ],
  };
}

function agentTurn(items: ChatItem[]): Turn {
  return { kind: "agent", speaker: "kin", items };
}

const onBack = jest.fn();

function element(turns: Turn[], extra: ViewProps = {}) {
  return (
    <ConversationView onBack={onBack} state={state(turns)} t={t} {...extra} />
  );
}

async function renderView(turns: Turn[], extra: ViewProps = {}): Promise<View> {
  return render(element(turns, extra));
}

/** The host FlatList, found by the id the view gives the list itself. */
function list(view: View) {
  return view.getByTestId("conversation:turns");
}

/** The platform event that follows a laid-out content box of `height`. */
async function contentHeight(view: View, height: number): Promise<void> {
  await fireEvent(list(view), "contentSizeChange", 390, height);
}

/** A scroll event at `offset` in content `height` tall. */
async function scrollTo(view: View, offset: number, height: number): Promise<void> {
  await fireEvent.scroll(list(view), {
    nativeEvent: {
      contentOffset: { x: 0, y: offset },
      contentSize: { width: 390, height },
      layoutMeasurement: { width: 390, height: VIEWPORT_HEIGHT },
    },
  });
}

describe("KIN-MOBILE-001 R4 reading a long conversation", () => {
  it("KIN-MOBILE-001 R4: the list opens at the last turn", async () => {
    const scrollToEnd = jest.spyOn(FlatList.prototype, "scrollToEnd");
    try {
      const view = await renderView([
        userTurn("first"),
        userTurn("second"),
        userTurn("third"),
      ]);

      await contentHeight(view, 1600);

      // One scroll, to the end, without animation: the newest segment is what
      // the person opened the conversation to read.
      expect(scrollToEnd).toHaveBeenCalledTimes(1);
      expect(scrollToEnd).toHaveBeenCalledWith({ animated: false });
    } finally {
      scrollToEnd.mockRestore();
    }
  });

  it("KIN-MOBILE-001 R4: a streamed append while the user reads above the end does not scroll", async () => {
    const scrollToEnd = jest.spyOn(FlatList.prototype, "scrollToEnd");
    try {
      const view = await renderView([userTurn("one"), userTurn("two")]);
      await contentHeight(view, 1600);
      expect(scrollToEnd).toHaveBeenCalledTimes(1);

      // The reader drags to the top of the thread: far outside the 48pt band.
      await scrollTo(view, 0, 1600);

      await view.rerender(element([userTurn("one"), userTurn("two"), userTurn("three")]));
      await contentHeight(view, 1800);

      // The stream grew, the page stayed where the person put it.
      expect(scrollToEnd).toHaveBeenCalledTimes(1);
    } finally {
      scrollToEnd.mockRestore();
    }
  });

  it("KIN-MOBILE-001 R4: returning to the end re-pins the stream", async () => {
    const scrollToEnd = jest.spyOn(FlatList.prototype, "scrollToEnd");
    try {
      const view = await renderView([userTurn("one"), userTurn("two")]);
      await contentHeight(view, 1600);
      await scrollTo(view, 0, 1600);

      // Back at the live edge, inside the band.
      await scrollTo(view, 1600, 1600);

      await view.rerender(element([userTurn("one"), userTurn("two"), userTurn("three")]));
      await contentHeight(view, 1800);

      expect(scrollToEnd).toHaveBeenCalledTimes(2);
      expect(scrollToEnd).toHaveBeenLastCalledWith({ animated: false });
    } finally {
      scrollToEnd.mockRestore();
    }
  });

  it("KIN-MOBILE-001 R4: a re-render with the same thread keeps the offset", async () => {
    const scrollToEnd = jest.spyOn(FlatList.prototype, "scrollToEnd");
    try {
      const turns = [userTurn("one"), userTurn("two")];
      const view = await renderView(turns);
      await contentHeight(view, 1600);
      expect(scrollToEnd).toHaveBeenCalledTimes(1);

      // The container repainted with the very same turns: no new content, so
      // nothing may move the page.
      await view.rerender(element(turns));
      await contentHeight(view, 1600);
      expect(scrollToEnd).toHaveBeenCalledTimes(1);
    } finally {
      scrollToEnd.mockRestore();
    }
  });

  it("KIN-MOBILE-001 R4: a tool row is a 44pt button and exposes its expanded state", async () => {
    const view = await renderView([agentTurn([toolCard("call-1", [toolStep()])])]);

    const row = view.getByTestId("conversation:tool:call-1");
    expect(row.props.accessibilityRole).toBe("button");
    expect(row.props.accessibilityState).toEqual({ expanded: false });
    const style = StyleSheet.flatten(row.props.style);
    expect(style.minHeight).toBeGreaterThanOrEqual(44);

    // Collapsed says the name and the status, and keeps the recorded detail
    // out of the reading flow.
    expect(view.getByText("bash")).toBeTruthy();
    expect(view.getByText(t("chat.progress.done"))).toBeTruthy();
    expect(view.queryByText("all green")).toBeNull();

    await fireEvent.press(row);

    const expanded = view.getByTestId("conversation:tool:call-1");
    expect(expanded.props.accessibilityState).toEqual({ expanded: true });
    expect(view.getByText("all green")).toBeTruthy();
  });

  it("KIN-MOBILE-001 R4: expanding a tool step survives a later streamed item", async () => {
    const tool = toolStep();
    // The card starts as the turn's first item...
    const before = [userTurn("run the tests"), agentTurn([toolCard("call-1", [tool])])];
    const view = await renderView(before);

    await fireEvent.press(view.getByTestId("conversation:tool:call-1"));
    expect(view.getByText("all green")).toBeTruthy();

    // ...then a note streams in ahead of it, so the same step now sits at a
    // different item position. Its expansion belongs to the step key, not the
    // position, and must still be open.
    const after = [
      userTurn("run the tests"),
      agentTurn([noteCard("note-1", "checking the suite"), toolCard("call-1", [tool])]),
    ];
    await view.rerender(element(after));

    expect(view.getByText("checking the suite")).toBeTruthy();
    expect(view.getByText("all green")).toBeTruthy();
    expect(
      view.getByTestId("conversation:tool:call-1").props.accessibilityState,
    ).toEqual({ expanded: true });
  });

  it("KIN-MOBILE-001 R4: a 300-turn thread renders fewer than 300 turn nodes initially", async () => {
    const turns = Array.from({ length: 300 }, (_, index) =>
      userTurn(`turn ${index}`),
    );
    const view = await renderView(turns);

    const rows = view.queryAllByTestId(/^conversation:turn:/);
    expect(rows.length).toBeGreaterThan(0);
    expect(rows.length).toBeLessThan(300);
  });
});
