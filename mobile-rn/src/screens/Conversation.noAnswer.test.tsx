import { describe, expect, it, jest } from "@jest/globals";
import { fireEvent, render } from "@testing-library/react-native";
import type { Turn } from "../../../ui/src/components/chat/transcriptProjection";
import type { ThreadState } from "../thread/threadModel";
import { t } from "../i18n";
// The default import keeps this file loadable on a tree without the predicate
// (the red-first check reverts `ConversationView.tsx` to `origin/main`); the
// module namespace carries the pure predicate the footer's guard is read
// through, so a missing export is an `undefined` call, not a suite that cannot
// start and so cannot name the test that failed.
import * as ConversationViewModule from "./ConversationView";

const ConversationView = ConversationViewModule.default;

/**
 * KIN-MOBILE-001 §3 空 — a settled conversation the agent never answered.
 *
 * The signed contract (`docs/product/stories/KIN-MOBILE-001.md:79`, §3 慢 / 空
 * / 失败 / 断线) asks the phone to say, in so many words, that the agent has
 * not answered. The line owns the spot the live round's thinking row (#779)
 * owns, so the two never show together, and every moment that is not a settled
 * unanswered conversation stays silent: an answered one, a live round, a first
 * load, and a failed read.
 */

const TASK_ID = "task-no-answer";

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

/** The shared projection stamps a person's message `speaker: "user"`. */
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

const onBack = jest.fn();

function element(turns: Turn[], extra: ViewProps = {}) {
  return (
    <ConversationView onBack={onBack} state={state(turns)} t={t} {...extra} />
  );
}

async function renderView(turns: Turn[], extra: ViewProps = {}) {
  return render(element(turns, extra));
}

describe("KIN-MOBILE-001 §3 the no-answer line", () => {
  it("KIN-MOBILE-001 §3: a settled conversation whose last turn is the user's draws 还没有回答", async () => {
    const turns = [userTurn("在吗")];
    const view = await renderView(turns, { onSend: jest.fn() });

    const row = view.getByTestId("conversation:no-answer");
    expect(row).toBeTruthy();
    expect(view.getByText(t("chat.noAnswer"))).toBeTruthy();
    // The live round's row is the other owner of this spot, never a sibling.
    expect(view.queryByTestId("conversation:thinking")).toBeNull();
    // It is the transcript's last line, above the composer.
    expect(view.getByTestId("conversation:composer")).toBeTruthy();
  });

  it("KIN-MOBILE-001 §3: an answered conversation draws no 还没有回答", async () => {
    const turns = [userTurn("在吗"), answerTurn("在的。")];
    const view = await renderView(turns);

    expect(view.getByText("在的。")).toBeTruthy();
    expect(view.queryByTestId("conversation:no-answer")).toBeNull();
    expect(view.queryByText(t("chat.noAnswer"))).toBeNull();
  });

  it("KIN-MOBILE-001 §3: a live round draws the thinking row and not 还没有回答", async () => {
    const live = state([userTurn("在吗")], { running: true });
    const view = await renderView([userTurn("在吗")], { state: live });

    expect(view.getByTestId("conversation:thinking")).toBeTruthy();
    expect(view.queryByTestId("conversation:no-answer")).toBeNull();

    // The footer checks the thinking row first, so the rendered tree alone
    // cannot prove this guard: a live round would still draw the row even if
    // the predicate stopped excluding it. The predicate is the contract, so
    // it is read directly. `undefined` is the pre-change module, and is not
    // `false`, so this also stays red without the predicate.
    const shouldShowNoAnswer = (
      ConversationViewModule as {
        shouldShowNoAnswer?: (state: ThreadState) => boolean;
      }
    ).shouldShowNoAnswer;
    expect(shouldShowNoAnswer?.(live)).toBe(false);
  });

  it("KIN-MOBILE-001 §3: a conversation that never loaded draws no 还没有回答", async () => {
    // The skeleton owns the first load (TASTE 15); a task with no turns can
    // say nothing about an answer either way.
    const view = await renderView([], {
      state: state([], { status: "loading" }),
    });

    expect(view.getByTestId("conversation-skeleton")).toBeTruthy();
    expect(view.queryByTestId("conversation:no-answer")).toBeNull();
    expect(view.queryByText(t("chat.noAnswer"))).toBeNull();
  });

  it("KIN-MOBILE-001 §3: a failed read keeps the error block and adds no 还没有回答", async () => {
    // A read that failed is not a settled conversation: the error block and
    // its retry own that moment, and claiming the agent never answered would
    // assert a fact the phone does not have.
    const view = await renderView([userTurn("在吗")], {
      onRetry: jest.fn(),
      state: state([userTurn("在吗")], { status: "error" }),
    });

    expect(view.getByText(t("sessions.loadErrorHint"))).toBeTruthy();
    expect(view.getByTestId("conversation:retry")).toBeTruthy();
    expect(view.queryByTestId("conversation:no-answer")).toBeNull();
    expect(view.queryByText(t("chat.noAnswer"))).toBeNull();
  });

  it("KIN-MOBILE-001 §3: the line is a polite status, not a control", async () => {
    const view = await renderView([userTurn("在吗")]);

    const row = view.getByTestId("conversation:no-answer");
    expect(row.props.accessibilityLiveRegion).toBe("polite");
    expect(row.props.accessibilityLabel).toBe(t("chat.noAnswer"));
    // Nothing to press: no button role, no press handler.
    expect(row.props.accessibilityRole).toBeUndefined();
    expect(row.props.onPress).toBeUndefined();
    await fireEvent.press(row);
    expect(onBack).not.toHaveBeenCalled();
  });
});
