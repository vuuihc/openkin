import { beforeEach, describe, expect, it, jest } from "@jest/globals";
import { fireEvent, render } from "@testing-library/react-native";
import { BackHandler, Text, View } from "react-native";

/**
 * KIN-MOBILE-001 R3 — the conversation route across the 768pt boundary.
 *
 * On a phone the route is the pushed conversation, exactly as before. At
 * 768pt and wider it draws the same 304pt list beside the conversation, so
 * rotating a conversation onto an iPad keeps both panes and the same task id.
 * Android's system back must close the conversation, not the app.
 */

let mockWidth = 390;
let mockId = "task-7";
const mockRouter = {
  back: jest.fn(),
  canGoBack: jest.fn(() => true),
  replace: jest.fn(),
  setParams: jest.fn(),
};

function mockListProbe({ onOpen }: { onOpen: (taskId: string) => void }) {
  return (
    <View testID="list-probe">
      <Text onPress={() => onOpen("task-9")} testID="row-nine">
        task-9
      </Text>
    </View>
  );
}

function mockConversationProbe({ taskId }: { taskId: string }) {
  return <Text testID="conversation">{taskId}</Text>;
}

jest.mock("../../src/layout/useListWidth", () => ({
  useListWidth: () => mockWidth,
}));

jest.mock("expo-router", () => ({
  useRouter: () => mockRouter,
  useLocalSearchParams: () => ({ id: mockId }),
}));

jest.mock("../../src/screens/ListScreen", () => ({
  __esModule: true,
  default: mockListProbe,
}));

jest.mock("../../src/screens/ConversationScreen", () => ({
  __esModule: true,
  default: mockConversationProbe,
}));

import ThreadRoute from "./[id]";

type BackHandlerListener = Parameters<typeof BackHandler.addEventListener>[1];

describe("KIN-MOBILE-001: the conversation route across the split boundary", () => {
  beforeEach(() => {
    mockWidth = 390;
    mockId = "task-7";
    mockRouter.back.mockClear();
    mockRouter.canGoBack.mockClear();
    mockRouter.replace.mockClear();
    mockRouter.setParams.mockClear();
  });

  it("KIN-MOBILE-001: at 390 the conversation route is only the conversation", async () => {
    const screen = await render(<ThreadRoute />);
    expect(screen.getByTestId("conversation").props.children).toBe("task-7");
    expect(screen.queryByTestId("list-probe")).toBeNull();
  });

  it("KIN-MOBILE-001: rotating 390 to 820 keeps the task id and draws the list beside it", async () => {
    const screen = await render(<ThreadRoute />);
    expect(screen.queryByTestId("list-probe")).toBeNull();

    mockWidth = 820;
    await screen.rerender(<ThreadRoute />);

    expect(screen.getByTestId("conversation").props.children).toBe("task-7");
    expect(screen.getByTestId("list-probe")).toBeTruthy();
    expect(screen.getByTestId("list-split-column")).toBeTruthy();
  });

  it("KIN-MOBILE-001: at 820 picking another row rewrites the URL's task id", async () => {
    mockWidth = 820;
    const screen = await render(<ThreadRoute />);

    await fireEvent.press(screen.getByTestId("row-nine"));

    expect(mockRouter.setParams).toHaveBeenCalledWith({ id: "task-9" });
  });

  it("KIN-MOBILE-001: at 820 Android's system back leaves the conversation for the list", async () => {
    const handlers: BackHandlerListener[] = [];
    const spy = jest
      .spyOn(BackHandler, "addEventListener")
      .mockImplementation((_event, handler) => {
        handlers.push(handler);
        return { remove: jest.fn() };
      });
    try {
      mockWidth = 820;
      await render(<ThreadRoute />);
      expect(handlers.length).toBeGreaterThan(0);

      const handled = handlers[0]!({ type: "hardwareBackPress", timeStamp: 0 });

      expect(handled).toBe(true);
      expect(mockRouter.back).toHaveBeenCalled();
    } finally {
      spy.mockRestore();
    }
  });

  it("KIN-MOBILE-001: a deep-linked split conversation's Back opens the list when there is no history", async () => {
    const handlers: BackHandlerListener[] = [];
    const spy = jest
      .spyOn(BackHandler, "addEventListener")
      .mockImplementation((_event, handler) => {
        handlers.push(handler);
        return { remove: jest.fn() };
      });
    try {
      mockRouter.canGoBack.mockReturnValueOnce(false);
      mockWidth = 820;
      await render(<ThreadRoute />);

      handlers[0]!({ type: "hardwareBackPress", timeStamp: 0 });

      expect(mockRouter.replace).toHaveBeenCalledWith("/list");
    } finally {
      spy.mockRestore();
    }
  });
});
