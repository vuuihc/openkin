import { beforeEach, describe, expect, it, jest } from "@jest/globals";
import { fireEvent, render, waitFor } from "@testing-library/react-native";
import { Text, View } from "react-native";

/**
 * KIN-MOBILE-001 R5 — the split route turns a settled pending decision into a
 * list re-read, and the phone route stays out of it.
 *
 * `ListScreen` already re-reads when its `focusEpoch` changes (pinned in
 * `src/screens/ListScreen.test.tsx` and `app/list.focus.test.tsx`); the split
 * route is the only place that can raise it for a decision made beside the
 * list. On a phone the list is not mounted, so the conversation must not be
 * handed a callback that would re-read a screen that does not exist.
 */

let mockWidth = 390;
let mockId = "task-7";
const mockRouter = {
  back: jest.fn(),
  canGoBack: jest.fn(() => true),
  replace: jest.fn(),
  setParams: jest.fn(),
};

function mockListProbe({
  focusEpoch,
}: {
  focusEpoch?: number;
}) {
  return (
    <View testID="list-probe">
      <Text testID="epoch">{String(focusEpoch ?? "none")}</Text>
    </View>
  );
}

function mockConversationProbe({
  taskId,
  onPendingSettled,
}: {
  taskId: string;
  onPendingSettled?: () => void;
}) {
  return (
    <View>
      <Text testID="conversation">{taskId}</Text>
      <Text testID="settle-wiring">
        {onPendingSettled === undefined ? "none" : "wired"}
      </Text>
      <Text onPress={() => onPendingSettled?.()} testID="settle">
        settle
      </Text>
    </View>
  );
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

describe("KIN-MOBILE-001 R5 thread route pending settle", () => {
  beforeEach(() => {
    mockWidth = 390;
    mockId = "task-7";
    mockRouter.back.mockClear();
    mockRouter.canGoBack.mockClear();
    mockRouter.replace.mockClear();
    mockRouter.setParams.mockClear();
  });

  it("KIN-MOBILE-001 R5: the split route re-reads the list when a pending decision settles", async () => {
    mockWidth = 820;
    const screen = await render(<ThreadRoute />);

    expect(screen.getByTestId("settle-wiring").props.children).toBe("wired");
    expect(screen.getByTestId("epoch").props.children).toBe("0");

    await fireEvent.press(screen.getByTestId("settle"));

    await waitFor(() =>
      expect(screen.getByTestId("epoch").props.children).toBe("1"),
    );
  });

  it("KIN-MOBILE-001 R5: the phone route hands the conversation no settle callback", async () => {
    mockWidth = 390;
    const screen = await render(<ThreadRoute />);

    expect(screen.getByTestId("conversation").props.children).toBe("task-7");
    expect(screen.queryByTestId("list-probe")).toBeNull();
    expect(screen.getByTestId("settle-wiring").props.children).toBe("none");
  });

  it("KIN-MOBILE-001 R5: switching rows still bumps the epoch exactly once", async () => {
    mockWidth = 820;
    const screen = await render(<ThreadRoute />);
    expect(screen.getByTestId("epoch").props.children).toBe("0");

    mockId = "task-9";
    await screen.rerender(<ThreadRoute />);
    await waitFor(() =>
      expect(screen.getByTestId("epoch").props.children).toBe("1"),
    );
    expect(screen.getByTestId("conversation").props.children).toBe("task-9");

    // A re-render that keeps the same id is not another focus event.
    await screen.rerender(<ThreadRoute />);
    expect(screen.getByTestId("epoch").props.children).toBe("1");
  });
});
