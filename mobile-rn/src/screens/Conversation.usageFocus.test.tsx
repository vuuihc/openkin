import { beforeEach, describe, expect, it, jest } from "@jest/globals";
import { fireEvent, render, waitFor } from "@testing-library/react-native";
import type { Turn } from "../../../ui/src/components/chat/transcriptProjection";
import { focusNode } from "../a11y/focus";
import type { ProvidersView } from "../providers/providersModel";
import type { ThreadState } from "../thread/threadModel";
import ConversationView from "./ConversationView";
import { SHEET_DISMISS_DISTANCE } from "./sheetDrag";

/**
 * KIN-MOBILE-001 §7 (`KIN-MOBILE-001.md:124`) — the reader's way back from the
 * usage sheet.
 *
 * The signed cell asks that closing the sheet returns the reader to the 用量
 * entry that opened it, whichever of the three close paths they used (the ×,
 * the scrim, the pull-down grabber). All three funnel through the sheet's one
 * `onClose` (`ProviderUsageSheet.tsx:113-117`), so the conversation view owns
 * the return move: the entry belongs to it, and a sheet rendered on its own
 * must not reach into the header.
 *
 * `focusNode` is mocked the way `ProviderUsage.firstOpen.test.tsx:28` mocks it,
 * so every assertion is about which node the view asked for, never a native
 * call.
 */

jest.mock("../a11y/focus", () => ({ focusNode: jest.fn(() => true) }));

const focusMock = jest.mocked(focusNode);

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

function agentTurn(text: string): Turn {
  return {
    kind: "agent",
    speaker: "kin",
    items: [{ kind: "message", key: `agent-${text}`, speaker: "kin", text }],
  };
}

/** A settled usage read: the sheet has its title and close control drawn. */
const USAGE: ProvidersView = {
  status: "empty",
  days: 30,
  providers: [],
  usage: [],
};

/** The testID of the node each recorded focus call landed on. */
function focusedTestIDs(): unknown[] {
  return focusMock.mock.calls.map(([ref]) => {
    const current = (ref as { current?: { props?: Record<string, unknown> } })
      ?.current;
    return current?.props?.testID;
  });
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

function conversation(turns: Turn[] = []) {
  return (
    <ConversationView
      onBack={jest.fn()}
      state={state({ turns })}
      t={t}
      usage={{ state: USAGE, onSelectWindow: jest.fn() }}
    />
  );
}

describe("KIN-MOBILE-001 §7 usage sheet return focus", () => {
  beforeEach(() => {
    focusMock.mockClear();
  });

  it("KIN-MOBILE-001 §7: closing the usage sheet returns the reader to the 用量 entry", async () => {
    const screen = await render(conversation([agentTurn("here is the plan")]));

    await fireEvent.press(screen.getByTestId("conversation:usage"));
    // Opening is the sheet's move, not the entry's: the reader is on the
    // sheet's title while it is up (KIN-MOBILE-001.md:124).
    expect(focusedTestIDs()).not.toContain("conversation:usage");

    await fireEvent.press(screen.getByTestId("usage-close"));

    // The move happens after the sheet is gone, so the entry is what the
    // reader lands on, once.
    await waitFor(() =>
      expect(focusedTestIDs()).toContain("conversation:usage"),
    );
    expect(
      focusedTestIDs().filter((id) => id === "conversation:usage"),
    ).toHaveLength(1);
    const props = focusedNodeProps();
    expect(props?.testID).toBe("conversation:usage");
    expect(props?.accessibilityLabel).toBe("usage.openPhone");
  });

  it("KIN-MOBILE-001 §7: a sheet the reader never opened moves no focus", async () => {
    // The entry effect legitimately moves the reader to the conversation's
    // title on mount; the 用量 entry is not a stop until a close puts them
    // back (no focus stealing, AGENTS.md §11).
    await render(conversation());

    expect(focusedTestIDs()).not.toContain("conversation:usage");
  });

  it("KIN-MOBILE-001 §7: a pull-down close returns the reader to the 用量 entry", async () => {
    const screen = await render(conversation());

    await fireEvent.press(screen.getByTestId("conversation:usage"));
    const handle = screen.getByTestId("usage-drag-handle", {
      includeHiddenElements: true,
    });
    // The strip is hidden from the reader but the finger reaches it; a travel
    // past the threshold is the third close path (`sheetDrag.ts:12`).
    const from = 300;
    const far = from + SHEET_DISMISS_DISTANCE + 24;
    await fireEvent(handle, "responderGrant", { nativeEvent: { pageY: from } });
    await fireEvent(handle, "responderMove", { nativeEvent: { pageY: far } });
    await fireEvent(handle, "responderRelease", { nativeEvent: { pageY: far } });

    await waitFor(() =>
      expect(focusedTestIDs()).toContain("conversation:usage"),
    );
  });

  it("KIN-MOBILE-001 §7: a repaint after the close does not move the reader again", async () => {
    const screen = await render(conversation());

    await fireEvent.press(screen.getByTestId("conversation:usage"));
    await fireEvent.press(screen.getByTestId("usage-close"));
    await waitFor(() =>
      expect(focusedTestIDs()).toContain("conversation:usage"),
    );
    const moves = focusMock.mock.calls.length;

    // A streamed append repaints the view while the sheet stays closed: the
    // return move already happened, so the reader is not moved a second time
    // (AGENTS.md §11).
    await screen.rerender(
      conversation([agentTurn("here is the plan"), agentTurn("and the rest")]),
    );

    expect(focusMock).toHaveBeenCalledTimes(moves);
    expect(
      focusedTestIDs().filter((id) => id === "conversation:usage"),
    ).toHaveLength(1);
  });
});
