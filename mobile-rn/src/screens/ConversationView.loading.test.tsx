import { describe, expect, it, jest } from "@jest/globals";
import { fireEvent, render } from "@testing-library/react-native";
import { StyleSheet } from "react-native";
import type { Turn } from "../../../ui/src/components/chat/transcriptProjection";
import type { ThreadState } from "../thread/threadModel";
import { t } from "../i18n";
import ConversationView from "./ConversationView";

/**
 * KIN-MOBILE-001 R4 — the conversation's first load on a slow link.
 *
 * The signed §3 cell asks for a message-area skeleton while the header and
 * composer are already usable. The bars are decorative: the container speaks
 * the one loading word the catalogue already has, and no bar is a reader stop.
 * A refresh that already has turns keeps them and draws no skeleton (TASTE 15).
 */

const TASK_ID = "task-loading";

type ViewProps = Partial<Parameters<typeof ConversationView>[0]>;
type View = Awaited<ReturnType<typeof render>>;

function state(
  turns: Turn[],
  overrides: Partial<ThreadState> = {},
): ThreadState {
  return {
    taskId: TASK_ID,
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

const onBack = jest.fn();

function element(turns: Turn[], extra: ViewProps = {}) {
  return (
    <ConversationView onBack={onBack} state={state(turns)} t={t} {...extra} />
  );
}

async function renderView(turns: Turn[], extra: ViewProps = {}): Promise<View> {
  return render(element(turns, extra));
}

describe("KIN-MOBILE-001 R4 the conversation's first load", () => {
  it("KIN-MOBILE-001 R4: a first load with no turns draws the message-area skeleton", async () => {
    const view = await renderView([], { state: state([], { status: "loading" }) });

    expect(view.getByTestId("conversation-skeleton")).toBeTruthy();
    expect(view.getAllByTestId("conversation-skeleton-bar")).toHaveLength(5);
    expect(view.getByTestId("conversation-skeleton-tool")).toBeTruthy();
    // The old lone caption is not body copy any more: the shape carries it.
    expect(view.queryByText(t("common.loading"))).toBeNull();
  });

  it("KIN-MOBILE-001 R4: a refresh that already has turns keeps them and draws no skeleton", async () => {
    const view = await renderView([userTurn("kept while refreshing")], {
      state: state([userTurn("kept while refreshing")], { status: "loading" }),
    });

    expect(view.getByText("kept while refreshing")).toBeTruthy();
    expect(view.queryByTestId("conversation-skeleton")).toBeNull();
  });

  it("KIN-MOBILE-001 R4: the skeleton speaks one loading word and exposes no bars to the reader", async () => {
    const view = await renderView([], { state: state([], { status: "loading" }) });

    const skeleton = view.getByTestId("conversation-skeleton");
    // `accessible` is what makes the one label a stop at all on iOS.
    expect(skeleton.props.accessible).toBe(true);
    expect(skeleton.props.accessibilityLabel).toBe(t("common.loading"));

    // Each real tool row is one stop; a decorative bar is none.
    const bars = [
      ...view.getAllByTestId("conversation-skeleton-bar"),
      view.getByTestId("conversation-skeleton-tool"),
    ];
    expect(bars).toHaveLength(6);
    for (const bar of bars) {
      expect(bar.props.accessibilityRole).toBeUndefined();
      expect(bar.props.accessibilityLabel).toBeUndefined();
      expect(bar.props.onPress).toBeUndefined();
      await fireEvent.press(bar);
    }
    expect(onBack).not.toHaveBeenCalled();
  });

  it("KIN-MOBILE-001 R4: a failed first read draws the error block, not a skeleton", async () => {
    const onRetry = jest.fn();
    const view = await renderView([], {
      onRetry,
      state: state([], { status: "error", reason: "unreachable" }),
    });

    expect(view.getByTestId("conversation:retry")).toBeTruthy();
    expect(view.queryByTestId("conversation-skeleton")).toBeNull();
  });

  it("KIN-MOBILE-001 R4: the skeleton never covers the header or the composer", async () => {
    const view = await renderView([], {
      onSend: jest.fn(),
      state: state([], { status: "loading" }),
    });

    expect(view.getByTestId("conversation-skeleton")).toBeTruthy();
    // The shell is live while the message area waits (signed §3).
    expect(view.getByTestId("conversation:back")).toBeTruthy();
    expect(view.getByTestId("conversation:composer")).toBeTruthy();
    expect(view.getByTestId("conversation:send")).toBeTruthy();
  });

  it("KIN-MOBILE-001 R4: the tool-shaped bar keeps the 44-point row height", async () => {
    const view = await renderView([], { state: state([], { status: "loading" }) });

    const tool = StyleSheet.flatten(
      view.getByTestId("conversation-skeleton-tool").props.style,
    );
    expect(tool.minHeight).toBeGreaterThanOrEqual(44);
  });
});
