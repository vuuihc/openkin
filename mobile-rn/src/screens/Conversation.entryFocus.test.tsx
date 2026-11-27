import { beforeEach, describe, expect, it, jest } from "@jest/globals";
import { render } from "@testing-library/react-native";
import { Children, type ReactElement } from "react";
import type { Turn } from "../../../ui/src/components/chat/transcriptProjection";
import { focusNode } from "../a11y/focus";
import type { ThreadState } from "../thread/threadModel";
import ConversationView from "./ConversationView";

/**
 * KIN-MOBILE-001 §3 (`KIN-MOBILE-001.md:80`) — where the reader starts when a
 * conversation opens.
 *
 * The signed cell asks three things of entry: the reader lands at the message
 * area's top rather than the composer (先读再写), VoiceOver starts at the
 * conversation's title, and the back control is the first stop. This view is
 * mounted whole by both routes (`app/list.tsx`, `app/thread/[id].tsx`), so the
 * entry seam is the view's own: one move per conversation, never repeated by a
 * repaint or a streamed append (AGENTS.md §11).
 *
 * `focusNode` is mocked the way `ProviderUsage.firstOpen.test.tsx:28,30,89`
 * mocks it, so every assertion is about which node the screen asked for, never
 * about a native call; the seam itself is proven in `a11y/focus.test.ts`.
 */

jest.mock("../a11y/focus", () => ({ focusNode: jest.fn(() => true) }));

const focusMock = jest.mocked(focusNode);

/**
 * The props of the node each focus call landed on, captured when it landed.
 * The ref itself is stable across renders, so reading it later would show the
 * latest header text, not the text the reader was moved to.
 */
const focusSnapshots: Array<Record<string, unknown> | undefined> = [];

const t = (key: string): string => key;

const TASK_ID = "task-1";

function state(overrides: Partial<ThreadState> = {}): ThreadState {
  return {
    taskId: TASK_ID,
    title: "Morning planning",
    status: "ready",
    turns: [],
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

function agentTurn(text: string): Turn {
  return {
    kind: "agent",
    speaker: "kin",
    items: [{ kind: "message", key: `agent-${text}`, speaker: "kin", text }],
  };
}

/** The props of the node the recorded focus call landed on. */
function focusedNodeProps(): Record<string, unknown> | undefined {
  const calls = focusMock.mock.calls;
  const call = calls[calls.length - 1];
  const ref = call?.[0] as
    | { current?: { props?: Record<string, unknown> } }
    | null
    | undefined;
  return ref?.current?.props;
}

/** The testID of the node each recorded focus call landed on. */
function focusedTestIDs(): unknown[] {
  return focusMock.mock.calls.map(([ref]) => {
    const current = (ref as { current?: { props?: Record<string, unknown> } })
      ?.current;
    return current?.props?.testID;
  });
}

/** A Text node's spoken text, whichever way the renderer flattened it. */
function textOf(props: Record<string, unknown> | undefined): string {
  const children = props?.children;
  return Array.isArray(children)
    ? children.map(String).join("")
    : String(children ?? "");
}

/** The text each focus call's node spoke at the moment it was moved to. */
function focusedTexts(): string[] {
  return focusSnapshots.map((props) => textOf(props));
}

describe("KIN-MOBILE-001 §3 conversation entry focus", () => {
  beforeEach(() => {
    focusMock.mockClear();
    focusSnapshots.length = 0;
    focusMock.mockImplementation((ref) => {
      const current = (
        ref as { current?: { props?: Record<string, unknown> } } | null
      )?.current;
      focusSnapshots.push(current?.props);
      return true;
    });
  });

  it("KIN-MOBILE-001 §3: entering a conversation moves reader focus to the title, not the composer", async () => {
    const screen = await render(
      <ConversationView
        onBack={jest.fn()}
        onSend={jest.fn()}
        state={state({ turns: [userTurn("plan the day"), agentTurn("here is the plan")] })}
        t={t}
      />,
    );

    expect(screen.getByTestId("conversation:title")).toBeTruthy();
    expect(focusMock).toHaveBeenCalledTimes(1);
    const props = focusedNodeProps();
    expect(props?.testID).toBe("conversation:title");
    expect(props?.accessibilityRole).toBe("header");
    expect(focusedTexts()).toEqual(["Morning planning"]);
    // The writing box is where the reader is *not* put on entry (先读再写).
    expect(focusedTestIDs()).not.toContain("conversation:composer");
  });

  it("KIN-MOBILE-001 §3: a conversation that opens while its read is still pending starts at the title the read names", async () => {
    // The container mounts the view before the read answers, with
    // `threadModel.emptyState`: `title: ""` (`threadModel.ts:134`), so the
    // header speaks the untitled placeholder. The real name lands with the
    // read (`threadModel.ts:295`), which is the first moment a move can
    // announce the conversation.
    const screen = await render(
      <ConversationView
        onBack={jest.fn()}
        onSend={jest.fn()}
        state={state({ status: "loading", title: "", turns: [] })}
        t={t}
      />,
    );

    // Moving on the placeholder would place the reader on "Untitled" and never
    // re-announce, so the slow state waits for the name (§3 慢).
    expect(focusMock).not.toHaveBeenCalled();

    await screen.rerender(
      <ConversationView
        onBack={jest.fn()}
        onSend={jest.fn()}
        state={state({
          status: "ready",
          title: "Morning planning",
          turns: [userTurn("plan the day")],
        })}
        t={t}
      />,
    );

    expect(focusMock).toHaveBeenCalledTimes(1);
    expect(focusedNodeProps()?.testID).toBe("conversation:title");
    // The node the move landed on already spoke the real name, not the
    // placeholder the header showed a moment earlier (§3 慢).
    expect(focusedTexts()).toEqual(["Morning planning"]);
  });

  it("KIN-MOBILE-001 §3: a read that settles without a name moves once, to the untitled heading", async () => {
    const screen = await render(
      <ConversationView
        onBack={jest.fn()}
        onSend={jest.fn()}
        state={state({ status: "loading", title: "", turns: [] })}
        t={t}
      />,
    );
    expect(focusMock).not.toHaveBeenCalled();

    // The read failed with no task row to name the conversation: there is
    // nothing left to wait for, so the placeholder is its announced name.
    await screen.rerender(
      <ConversationView
        onBack={jest.fn()}
        onSend={jest.fn()}
        state={state({ status: "error", title: "", turns: [] })}
        t={t}
      />,
    );
    expect(focusMock).toHaveBeenCalledTimes(1);
    expect(focusedTexts()).toEqual(["sessions.untitled"]);

    // A name that lands after the settle is still the same entry: the reader
    // is not moved a second time (AGENTS.md §11).
    await screen.rerender(
      <ConversationView
        onBack={jest.fn()}
        onSend={jest.fn()}
        state={state({ status: "ready", title: "Morning planning", turns: [] })}
        t={t}
      />,
    );
    expect(focusMock).toHaveBeenCalledTimes(1);
  });

  it("KIN-MOBILE-001 §3: a later repaint or a streamed append does not move the reader again", async () => {
    const screen = await render(
      <ConversationView
        onBack={jest.fn()}
        state={state({ turns: [userTurn("plan the day")] })}
        t={t}
      />,
    );
    expect(focusMock).toHaveBeenCalledTimes(1);

    // Same conversation, new state object: a streamed append repaints with a
    // longer transcript, and the read settling changes the status.
    await screen.rerender(
      <ConversationView
        onBack={jest.fn()}
        state={state({
          status: "ready",
          turns: [
            userTurn("plan the day"),
            agentTurn("here is the plan"),
            agentTurn("and the afternoon"),
          ],
        })}
        t={t}
      />,
    );

    expect(focusMock).toHaveBeenCalledTimes(1);
    expect(focusedNodeProps()?.testID).toBe("conversation:title");
  });

  it("KIN-MOBILE-001 §3: another conversation in the same view focuses its own title once", async () => {
    const screen = await render(
      <ConversationView
        onBack={jest.fn()}
        state={state({ taskId: "task-1", title: "Morning planning" })}
        t={t}
      />,
    );
    expect(focusMock).toHaveBeenCalledTimes(1);

    // The split route swaps the conversation in place (`app/list.tsx:166`);
    // that is a new entry, not a repaint of the old one.
    await screen.rerender(
      <ConversationView
        onBack={jest.fn()}
        state={state({ taskId: "task-2", title: "Afternoon review" })}
        t={t}
      />,
    );

    expect(focusMock).toHaveBeenCalledTimes(2);
    const props = focusedNodeProps();
    expect(props?.testID).toBe("conversation:title");
    expect(textOf(props)).toBe("Afternoon review");
  });

  it("KIN-MOBILE-001 §3: the back control is the header's first stop, before the title", async () => {
    const screen = await render(
      <ConversationView
        onBack={jest.fn()}
        state={state({ title: "Release notes", running: true })}
        t={t}
        usage={{
          state: { status: "empty", days: 30, providers: [], usage: [] },
          onSelectWindow: jest.fn(),
        }}
      />,
    );

    const header = screen.getByTestId("conversation:header");
    const children = Children.toArray(
      header.props.children,
    ) as ReactElement<Record<string, unknown>>[];
    const back = children.findIndex(
      (child) => child.props.testID === "conversation:back",
    );
    const firstControl = children.findIndex(
      (child) =>
        typeof child.props.onPress === "function" ||
        child.props.accessibilityRole === "button",
    );
    const title = children.findIndex(
      (child) => child.props.testID === "conversation:title",
    );

    // The glass layer precedes the row and is decoration; the back control is
    // still the header's first stop.
    expect(firstControl).toBe(back);
    expect(title).toBeGreaterThan(back);
  });

  it("KIN-MOBILE-001 §3: the composer carries no entry autoFocus", async () => {
    const screen = await render(
      <ConversationView
        onBack={jest.fn()}
        onSend={jest.fn()}
        state={state()}
        t={t}
      />,
    );

    // Nothing raises the keyboard on entry (先读再写): focus is the person's
    // own move into the box, never the route's.
    expect(
      screen.getByTestId("conversation:composer").props.autoFocus,
    ).toBeFalsy();
  });
});
