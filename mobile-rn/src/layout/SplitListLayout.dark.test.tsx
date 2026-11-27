import { beforeEach, describe, expect, it, jest } from "@jest/globals";
import { render } from "@testing-library/react-native";
import { StyleSheet, Text, useColorScheme, View } from "react-native";
import { palette } from "../theme/tokens";
import SplitListLayout from "./SplitListLayout";

/**
 * KIN-MOBILE-001 R3 — the split paints the page, not the navigator's white.
 *
 * EVIDENCE.md §已知 D4 recorded the defect: at 820 in dark mode the left list
 * was dark while the right empty pane stayed white with dark text. The split
 * root painted nothing, so the pane showed whatever the navigator's screen
 * background was. A selected conversation looked right only because
 * `ConversationView` paints its own container; the empty pane had no such
 * owner, and the phone stack's screens already paint their own `colors.bg`.
 *
 * `useColorScheme` is mocked at the platform module the hook imports, as
 * `Conversation.visual.test.tsx:36-42` does, and the expected colours come
 * from `theme/tokens` — a hard-coded dark value cannot pass both schemes.
 */

jest.mock("react-native/Libraries/Utilities/useColorScheme", () => ({
  __esModule: true,
  default: jest.fn(),
}));

const systemScheme = jest.mocked(useColorScheme) as jest.MockedFunction<
  () => ReturnType<typeof useColorScheme> | undefined
>;

const EMPTY_LABEL = "在左侧选一条对话，在这里阅读。";

const list = (
  <View testID="list-probe">
    <Text>task-a</Text>
  </View>
);

type Rendered = Awaited<ReturnType<typeof render>>;

async function renderSplit(
  width: number,
  selectedTaskId: string | null,
): Promise<Rendered> {
  return render(
    <SplitListLayout
      conversation={selectedTaskId === null ? null : <Text>conversation</Text>}
      emptyLabel={EMPTY_LABEL}
      list={list}
      selectedTaskId={selectedTaskId}
      width={width}
    />,
  );
}

/** The colour the split root actually paints, flattened from its style array. */
function rootBackground(screen: Rendered) {
  const style = StyleSheet.flatten(screen.getByTestId("list-layout").props.style);
  return style.backgroundColor;
}

describe("KIN-MOBILE-001 R3: the split paints the page background", () => {
  beforeEach(() => {
    systemScheme.mockReset();
  });

  it("KIN-MOBILE-001 R3: the split's empty reading pane paints the dark page background, not the navigator's white", async () => {
    systemScheme.mockReturnValue("dark");
    const screen = await renderSplit(820, null);

    // The sentence is still there; only the surface under it was wrong.
    expect(screen.getByText(EMPTY_LABEL)).toBeTruthy();
    expect(screen.getByTestId("list-split-conversation")).toBeTruthy();

    // The root is the view that paints the pane: it sits above both the empty
    // state and the conversation, and neither of those owns a background. Pin
    // that ownership too: a later opaque fill on the pane or the empty state
    // would hide the root's page again while the assertion above stayed green.
    expect(rootBackground(screen)).toBe(palette.dark.bg);
    const pane = StyleSheet.flatten(
      screen.getByTestId("list-split-conversation").props.style,
    );
    expect(pane.backgroundColor).toBeUndefined();
    const emptyView = screen.getByText(EMPTY_LABEL).parent;
    expect(StyleSheet.flatten(emptyView?.props.style)?.backgroundColor).toBeUndefined();
  });

  it("KIN-MOBILE-001 R3: the empty pane follows the light scheme too", async () => {
    systemScheme.mockReturnValue("light");
    const screen = await renderSplit(820, null);

    expect(screen.getByText(EMPTY_LABEL)).toBeTruthy();
    expect(rootBackground(screen)).toBe(palette.light.bg);
  });

  it("KIN-MOBILE-001 R3: a selected conversation keeps the split's background and the phone stack keeps its geometry", async () => {
    systemScheme.mockReturnValue("dark");
    const selected = await renderSplit(820, "task-a");
    expect(rootBackground(selected)).toBe(palette.dark.bg);

    // The phone stack renders no right pane; the root still paints, and the
    // stack column keeps the geometry it had before the fix.
    const stack = await renderSplit(767, "task-a");
    expect(stack.queryByTestId("list-split-conversation")).toBeNull();
    expect(rootBackground(stack)).toBe(palette.dark.bg);
    const column = StyleSheet.flatten(
      stack.getByTestId("list-stack-column").props.style,
    );
    expect(column.flex).toBe(1);
    expect(column.width).toBeUndefined();
  });
});
