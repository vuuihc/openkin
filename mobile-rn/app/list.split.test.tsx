import { beforeEach, describe, expect, it, jest } from "@jest/globals";
import { fireEvent, render, waitFor } from "@testing-library/react-native";
import { BackHandler, Pressable, StyleSheet, Text, View } from "react-native";

/**
 * KIN-MOBILE-001 R3 — the list route across the 768pt boundary.
 *
 * The presentation is proven in `src/layout/SplitListLayout.test.tsx`; this
 * suite is about the route's navigations: a row tap at 820 rewrites the
 * `thread` URL param (the right pane follows it) and re-reads the list's
 * badges, a row tap at 390 still pushes `/thread/<id>`, shrinking a split to
 * phone width hands the same task id to the stack route without losing the
 * list beneath it, and Android's system back closes the split's conversation.
 *
 * `useListWidth` and the two screens are mocked so the route is exercised
 * without a window or a network; `expo-router` records the calls.
 */

let mockWidth = 820;
let mockParams: { thread?: string } = {};
const mockRouter = {
  push: jest.fn(),
  replace: jest.fn(),
  setParams: jest.fn(),
};

function mockListProbe({
  onOpen,
  focusEpoch,
}: {
  onOpen: (taskId: string) => void;
  focusEpoch?: number;
}) {
  return (
    <View testID="list-probe">
      <Pressable onPress={() => onOpen("task-a")} testID="row-a">
        <Text>task-a</Text>
      </Pressable>
      <Text testID="epoch">{String(focusEpoch ?? 0)}</Text>
    </View>
  );
}

function mockConversationProbe({ taskId }: { taskId: string }) {
  return <Text testID="conversation">{taskId}</Text>;
}

jest.mock("../src/layout/useListWidth", () => ({
  useListWidth: () => mockWidth,
}));

jest.mock("expo-router", () => ({
  useRouter: () => mockRouter,
  useFocusEffect: () => {},
  useLocalSearchParams: () => mockParams,
}));

jest.mock("../src/auth/pairing", () => ({
  pairing: {
    startRoute: jest.fn(async () => ({
      route: "list",
      reason: "none",
      origin: "https://kin.example.com",
      tasks: [],
      display: null,
    })),
  },
}));

jest.mock("../src/screens/ListScreen", () => ({
  __esModule: true,
  default: mockListProbe,
}));

jest.mock("../src/screens/ConversationScreen", () => ({
  __esModule: true,
  default: mockConversationProbe,
}));

import { t } from "../src/i18n";
import ListRoute from "./list";

type BackHandlerListener = Parameters<typeof BackHandler.addEventListener>[1];

async function renderLoaded() {
  const screen = await render(<ListRoute />);
  await waitFor(() => expect(screen.getByTestId("list-probe")).toBeTruthy());
  return screen;
}

describe("KIN-MOBILE-001: the list route across the split boundary", () => {
  beforeEach(() => {
    mockWidth = 820;
    mockParams = {};
    mockRouter.push.mockClear();
    mockRouter.replace.mockClear();
    mockRouter.setParams.mockClear();
  });

  it("KIN-MOBILE-001: at 820 a row tap shows that conversation beside the list and the URL carries the task id", async () => {
    const screen = await renderLoaded();

    // 304pt column that cannot grow or shrink away from the signed width,
    // empty right pane until something is chosen.
    const column = StyleSheet.flatten(
      screen.getByTestId("list-split-column").props.style,
    );
    expect(column.width).toBe(304);
    expect(column.flexGrow).toBe(0);
    expect(screen.getByText(t("sessions.selectConversation"))).toBeTruthy();

    await fireEvent.press(screen.getByTestId("row-a"));

    expect(mockRouter.setParams).toHaveBeenCalledWith({ thread: "task-a" });
    expect(mockRouter.push).not.toHaveBeenCalled();
    // The list is still there, and it re-read the server's badges because the
    // split has no focus change to signal a return (KIN-MOBILE-001 R5).
    expect(screen.getByTestId("list-probe")).toBeTruthy();
    expect(screen.getByTestId("epoch").props.children).toBe("1");
  });

  it("KIN-MOBILE-001: at 820 a deep link's task id opens its conversation beside the list", async () => {
    mockParams = { thread: "task-7" };
    const screen = await renderLoaded();

    expect(screen.getByTestId("conversation").props.children).toBe("task-7");
    expect(screen.getByTestId("list-probe")).toBeTruthy();
    expect(mockRouter.replace).not.toHaveBeenCalled();
  });

  it("KIN-MOBILE-001: at 820 Android's system back closes the conversation instead of the app", async () => {
    const handlers: BackHandlerListener[] = [];
    const spy = jest
      .spyOn(BackHandler, "addEventListener")
      .mockImplementation((_event, handler) => {
        handlers.push(handler);
        return { remove: jest.fn() };
      });
    try {
      mockParams = { thread: "task-7" };
      await renderLoaded();
      expect(handlers.length).toBeGreaterThan(0);

      const handled = handlers[0]!({ type: "hardwareBackPress", timeStamp: 0 });

      expect(handled).toBe(true);
      expect(mockRouter.setParams).toHaveBeenCalledWith({ thread: undefined });
    } finally {
      spy.mockRestore();
    }
  });

  it("KIN-MOBILE-001: at 390 a row tap still pushes the stack route", async () => {
    mockWidth = 390;
    const screen = await renderLoaded();

    expect(screen.queryByTestId("list-split-column")).toBeNull();
    await fireEvent.press(screen.getByTestId("row-a"));

    expect(mockRouter.push).toHaveBeenCalledWith("/thread/task-a");
    expect(mockRouter.setParams).not.toHaveBeenCalled();
  });

  it("KIN-MOBILE-001: shrinking 820 to 390 keeps the task id on the stack route over the list", async () => {
    mockParams = { thread: "task-7" };
    const screen = await renderLoaded();
    expect(screen.getByTestId("conversation").props.children).toBe("task-7");

    mockWidth = 390;
    await screen.rerender(<ListRoute />);

    await waitFor(() =>
      expect(mockRouter.push).toHaveBeenCalledWith("/thread/task-7"),
    );
    // The list's own param is cleared before the push, so Back lands on the
    // list instead of bouncing into the conversation again.
    expect(mockRouter.setParams).toHaveBeenCalledWith({ thread: undefined });
    expect(mockRouter.replace).not.toHaveBeenCalled();
  });
});
