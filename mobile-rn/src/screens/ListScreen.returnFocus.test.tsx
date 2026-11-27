import { beforeEach, describe, expect, it, jest } from "@jest/globals";
import { fireEvent, render, waitFor } from "@testing-library/react-native";
import { StyleSheet } from "react-native";
import type { Task } from "../../../ui/src/api/contract";
import type { Machine } from "../../../ui/src/lib/devices";
import { focusNode } from "../a11y/focus";
import { listTasksPath } from "../api/transport";
import type { Session } from "../auth/tokenStore";
import {
  createListMemory,
  type ConversationRow,
  type DeviceGroup,
  type ListMemory,
  type ListViewState,
} from "../list/listModel";
import ConversationList, { FOCUS_RING } from "./ConversationList";
import ListScreen from "./ListScreen";

// The seam, not React Native: the screen only has to say where the reader
// goes, and `focusNode` is the one function that talks to the platform.
jest.mock("../a11y/focus", () => ({ focusNode: jest.fn(() => true) }));

const focusMock = jest.mocked(focusNode);

/**
 * KIN-MOBILE-001 §2 键盘与焦点 — Back returns the reader to the row they left.
 *
 * The list already remembers the ring's row, paints it on return and lets the
 * arrows continue from it (`ListScreen.test.tsx`). What was missing is the
 * screen-reader move: after Back, VoiceOver focus must land on that same row,
 * not on the screen's first control and not wherever the platform drops it.
 * The route keeps a return epoch separate from the data epoch so a split
 * pane switch — which is not a return — can never steal the reader.
 *
 * `focusNode` is mocked, so this suite proves which node the screen asks for,
 * not that iOS lands there; `src/a11y/focus.test.ts` proves that seam.
 */

const ORIGIN = "https://kin.example.com";
const TOKEN = "test-token";

const MACHINES: Machine[] = [
  { id: "dev-a", label: "Laptop", isSelf: true, online: true, roots: [], agents: [] },
];

function task(overrides: Partial<Task> = {}): Task {
  return {
    id: "task-1",
    title: "First conversation",
    agent: "kin",
    cwd: "/work/alpha",
    prompt: "hello",
    model: "model-x",
    status: "succeeded",
    tokens_in: 0,
    tokens_out: 0,
    created_at: 1000,
    started_at: 1000,
    finished_at: 1000,
    executing_device_id: "dev-a",
    event_epoch: 0,
    ...overrides,
  };
}

function storedSession(): Promise<Session | null> {
  return Promise.resolve({ kind: "node", origin: ORIGIN, token: TOKEN });
}

function ok(body: unknown, status = 200): Response {
  return {
    ok: status >= 200 && status < 300,
    status,
    json: async () => body,
  } as unknown as Response;
}

type Reply = { status?: number; body: unknown };
type Router = (url: string, init?: RequestInit) => Reply | Promise<Reply>;

function routedFetch(route: Router): typeof fetch {
  return jest.fn(async (input: string, init?: RequestInit) => {
    const reply = await route(input, init);
    return ok(reply.body, reply.status ?? 200);
  }) as unknown as typeof fetch;
}

function formatTime(at: number): string {
  return `t${at}`;
}

/** One project, so the visual row order is exactly a1, a2, a3. */
function threeRows(): typeof fetch {
  return routedFetch((url) => {
    if (!url.endsWith(listTasksPath())) return { body: [] };
    const rows = [
      { id: "a1", title: "Alpha one", at: 1000 },
      { id: "a2", title: "Alpha two", at: 900 },
      { id: "a3", title: "Alpha three", at: 800 },
    ];
    return {
      body: rows.map(({ id, title, at }) =>
        task({
          id,
          title,
          cwd: "/work/alpha",
          created_at: at,
          started_at: at,
          finished_at: at,
        }),
      ),
    };
  });
}

/** The stable props a test renders and rerenders with. */
function listProps(memory: ListMemory = createListMemory()) {
  return {
    fetchImpl: threeRows(),
    formatTime,
    machines: MACHINES,
    memory,
    onNeedsPairing: jest.fn(),
    onOpen: jest.fn(),
    readSessionImpl: storedSession,
    selfDeviceId: "dev-a",
  };
}

/** A view state with exactly the given rows, in one open project. */
function rowState(ids: readonly string[]): ListViewState {
  const rows: ConversationRow[] = ids.map((id, index) => ({
    id,
    title: `${id} title`,
    agentId: "kin",
    at: 1000 - index,
    timeLabel: `t${1000 - index}`,
    statusKey: "sessions.statusSucceeded",
    status: "succeeded",
    pending: 0,
    remote: false,
  }));
  const groups: DeviceGroup[] = [
    {
      id: "dev-a",
      label: "Laptop",
      isSelf: true,
      online: true,
      count: rows.length,
      projects: [
        {
          key: "/work/alpha",
          label: "Alpha",
          open: true,
          lastActivityAt: 1000,
          rows,
        },
      ],
    },
  ];
  return { status: "ready", groups, error: null };
}

const t = (key: string): string => key;

/** The pure list, with a ring row the first paint does not hold. */
function conversationList(state: ListViewState, returnFocusEpoch: number) {
  return (
    <ConversationList
      initialFocusId="a3"
      onOpen={() => {}}
      onQueryChange={() => {}}
      onRefresh={() => {}}
      query=""
      returnFocusEpoch={returnFocusEpoch}
      state={state}
      t={t}
    />
  );
}

/** The props of the node the last recorded focus call landed on. */
function focusedNodeProps(): Record<string, unknown> | undefined {
  const calls = focusMock.mock.calls;
  const call = calls[calls.length - 1];
  const ref = call?.[0] as
    | { current?: { props?: Record<string, unknown> } }
    | null
    | undefined;
  return ref?.current?.props;
}

describe("KIN-MOBILE-001 §2 reader focus returns to the row", () => {
  beforeEach(() => {
    focusMock.mockClear();
  });

  it("KIN-MOBILE-001 §2: Back moves reader focus to the row the reader left", async () => {
    const props = listProps();
    const screen = await render(
      <ListScreen {...props} focusEpoch={0} returnFocusEpoch={0} />,
    );
    await waitFor(() => expect(screen.getByTestId("row:a1")).toBeTruthy());
    expect(focusMock).not.toHaveBeenCalled();

    // The reader taps a row and leaves the list for that conversation.
    await fireEvent.press(screen.getByTestId("row:a2"));
    expect(props.onOpen).toHaveBeenCalledWith("a2");

    // Back: the route reports a focus regain with both epochs bumped, and the
    // reader lands on the row they came from — not the search field, not a1.
    await screen.rerender(
      <ListScreen {...props} focusEpoch={1} returnFocusEpoch={1} />,
    );
    expect(focusMock).toHaveBeenCalledTimes(1);
    expect(focusedNodeProps()?.testID).toBe("row:a2");
  });

  it("KIN-MOBILE-001 §2: the return lands on the remembered row, not the first row", async () => {
    const memory = createListMemory();
    memory.write({ focusedRowId: "a3" });
    const props = listProps(memory);
    const screen = await render(
      <ListScreen {...props} focusEpoch={0} returnFocusEpoch={0} />,
    );
    await waitFor(() => expect(screen.getByTestId("row:a3")).toBeTruthy());
    expect(
      StyleSheet.flatten(screen.getByTestId("row:a3").props.style).borderColor,
    ).toBe(FOCUS_RING);

    await screen.rerender(
      <ListScreen {...props} focusEpoch={1} returnFocusEpoch={1} />,
    );
    expect(focusMock).toHaveBeenCalledTimes(1);
    expect(focusedNodeProps()?.testID).toBe("row:a3");
    // A first-row fallback would pass a weaker assertion; this rules it out.
    expect(focusedNodeProps()?.testID).not.toBe("row:a1");
  });

  it("KIN-MOBILE-001 §2: a data refresh alone does not move the reader", async () => {
    const props = listProps();
    const screen = await render(
      <ListScreen {...props} focusEpoch={0} returnFocusEpoch={0} />,
    );
    await waitFor(() => expect(screen.getByTestId("row:a1")).toBeTruthy());
    await fireEvent.press(screen.getByTestId("row:a2"));

    // A split open/switch/close bumps only the data epoch: the list never lost
    // focus, and moving reader focus out of the conversation pane would be a
    // steal, so nothing may move.
    await screen.rerender(
      <ListScreen {...props} focusEpoch={1} returnFocusEpoch={0} />,
    );
    expect(focusMock).not.toHaveBeenCalled();
  });

  it("KIN-MOBILE-001 §2: a fresh list moves no reader focus", async () => {
    const screen = await render(
      <ListScreen {...listProps()} focusEpoch={0} returnFocusEpoch={0} />,
    );
    await waitFor(() => expect(screen.getByTestId("row:a1")).toBeTruthy());
    expect(focusMock).not.toHaveBeenCalled();
  });

  it("KIN-MOBILE-001 §2: a remembered ring restored at mount moves no reader focus", async () => {
    const memory = createListMemory();
    memory.write({ focusedRowId: "a3" });
    const screen = await render(
      <ListScreen {...listProps(memory)} focusEpoch={0} returnFocusEpoch={0} />,
    );
    await waitFor(() => expect(screen.getByTestId("row:a3")).toBeTruthy());
    // The ring is restored, but the mount is not a return: the reader is
    // arriving, and the list must not yank their focus on the first paint.
    expect(focusMock).not.toHaveBeenCalled();
  });

  it("KIN-MOBILE-001 §2: a return with no remembered row moves no focus", async () => {
    const props = listProps();
    const screen = await render(
      <ListScreen {...props} focusEpoch={0} returnFocusEpoch={0} />,
    );
    await waitFor(() => expect(screen.getByTestId("row:a1")).toBeTruthy());

    // A deep link straight into a conversation never had an originating row:
    // there is nothing to return to, and the first row is not it.
    await screen.rerender(
      <ListScreen {...props} focusEpoch={1} returnFocusEpoch={1} />,
    );
    expect(focusMock).not.toHaveBeenCalled();
  });

  it("KIN-MOBILE-001 §2: a ring move after the return does not move reader focus again", async () => {
    const props = listProps();
    const screen = await render(
      <ListScreen {...props} focusEpoch={0} returnFocusEpoch={0} />,
    );
    await waitFor(() => expect(screen.getByTestId("row:a1")).toBeTruthy());
    await fireEvent.press(screen.getByTestId("row:a2"));
    await screen.rerender(
      <ListScreen {...props} focusEpoch={1} returnFocusEpoch={1} />,
    );
    expect(focusMock).toHaveBeenCalledTimes(1);

    // The reader arrows on with the hardware keyboard: the ring moves, and the
    // one return already happened. Reader focus must not chase every move.
    await fireEvent(screen.getByTestId("list-scroller"), "keyDown", {
      nativeEvent: { key: "ArrowDown" },
    });
    expect(
      StyleSheet.flatten(screen.getByTestId("row:a3").props.style).borderColor,
    ).toBe(FOCUS_RING);
    expect(focusMock).toHaveBeenCalledTimes(1);
    expect(focusedNodeProps()?.testID).toBe("row:a2");
  });

  it("KIN-MOBILE-001 §2: a return whose row arrives after the repaint moves the reader when it mounts", async () => {
    // The ring row is not in the page yet (a data refresh still on its way).
    const screen = await render(conversationList(rowState(["a1", "a2"]), 0));
    expect(screen.queryByTestId("row:a3")).toBeNull();

    await screen.rerender(conversationList(rowState(["a1", "a2"]), 1));
    // No node to focus: the return waits for the row's own ref callback.
    expect(focusMock).not.toHaveBeenCalled();

    await screen.rerender(conversationList(rowState(["a1", "a2", "a3"]), 1));
    expect(focusMock).toHaveBeenCalledTimes(1);
    expect(focusedNodeProps()?.testID).toBe("row:a3");
  });

  it("KIN-MOBILE-001 §2: a return still waiting for its row is dropped when the reader moves to search", async () => {
    const screen = await render(conversationList(rowState(["a1", "a2"]), 0));
    await screen.rerender(conversationList(rowState(["a1", "a2"]), 1));
    expect(focusMock).not.toHaveBeenCalled();

    // The reader moves to the search field: a return that lands after this
    // would pull them off the control they are on (AGENTS.md rule 11).
    await fireEvent(screen.getByTestId("list-search"), "focus");
    await screen.rerender(conversationList(rowState(["a1", "a2", "a3"]), 1));
    expect(focusMock).not.toHaveBeenCalled();
  });

  it("KIN-MOBILE-001 §2: a return still waiting for its row is dropped when the reader types a query", async () => {
    const screen = await render(conversationList(rowState(["a1", "a2"]), 0));
    await screen.rerender(conversationList(rowState(["a1", "a2"]), 1));
    expect(focusMock).not.toHaveBeenCalled();

    await fireEvent.changeText(screen.getByTestId("list-search"), "al");
    await screen.rerender(conversationList(rowState(["a1", "a2", "a3"]), 1));
    expect(focusMock).not.toHaveBeenCalled();
  });
});
