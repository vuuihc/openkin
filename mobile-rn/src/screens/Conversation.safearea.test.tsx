import { describe, expect, it, jest } from "@jest/globals";
import { render } from "@testing-library/react-native";
import { KeyboardAvoidingView, StyleSheet } from "react-native";
import { SafeAreaProvider } from "react-native-safe-area-context";
import type { ThreadState } from "../thread/threadModel";
import { t } from "../i18n";
import ConversationView from "./ConversationView";

/**
 * KIN-MOBILE-001 R4/R7 — the phone's keyboard and safe areas.
 *
 * The conversation is drawn under a provider carrying a notched iPhone's
 * metrics, so the header and composer are asserted against the device the
 * story names. The zero-inset case is the control: a device without a notch
 * must keep the compact shape the reading suites already render.
 *
 * The provider is per-test, not a global mock: the rest of the phone's suite
 * renders views without insets and must stay unaffected.
 */

const TASK_ID = "task-safe-area";

function state(): ThreadState {
  return {
    taskId: TASK_ID,
    title: "Morning planning",
    status: "ready",
    turns: [],
    running: false,
    sendQueue: [],
    banner: null,
    reason: null,
  };
}

const onBack = jest.fn();
const onSend = jest.fn();

/** The conversation under a provider carrying `top`/`bottom` insets. */
function withInsets(top: number, bottom: number) {
  return (
    <SafeAreaProvider
      initialMetrics={{
        frame: { x: 0, y: 0, width: 390, height: 844 },
        insets: { top, left: 0, right: 0, bottom },
      }}
    >
      <ConversationView
        onBack={onBack}
        onSend={onSend}
        state={state()}
        t={t}
      />
    </SafeAreaProvider>
  );
}

/**
 * The React fiber behind a host node, narrowed to the two fields this suite
 * reads. Testing Library 14 resolves props on host elements, so a composite
 * component such as `KeyboardAvoidingView` is not a query result; the
 * composer's ancestry is where its behavior is observable.
 */
type FiberNode = {
  elementType?: unknown;
  memoizedProps?: Record<string, unknown>;
  return?: FiberNode | null;
};

function ancestorOfType(
  fiber: FiberNode | null | undefined,
  type: unknown,
): FiberNode | null {
  for (let node = fiber ?? null; node; node = node.return ?? null) {
    if (node.elementType === type) return node;
  }
  return null;
}

function keyboardBoxOf(composer: { unstable_fiber: unknown }): FiberNode {
  const box = ancestorOfType(
    composer.unstable_fiber as FiberNode | null,
    KeyboardAvoidingView,
  );
  expect(box).not.toBeNull();
  return box as FiberNode;
}

describe("KIN-MOBILE-001 R4 keyboard and safe areas", () => {
  it("KIN-MOBILE-001 R4: the header's top padding is the device's inset plus 8", async () => {
    const screen = await render(withInsets(59, 34));

    const header = screen.getByTestId("conversation:header");
    const style = StyleSheet.flatten(header.props.style);
    expect(style.paddingTop).toBe(67);
  });

  it("KIN-MOBILE-001 R4: the composer sits above the keyboard", async () => {
    const screen = await render(withInsets(59, 34));

    // The composer rides inside the keyboard-avoiding box, so opening the
    // keyboard moves the composer and shrinks the transcript on iOS.
    const composer = screen.getByTestId("conversation:composerBar");
    const box = keyboardBoxOf(composer);
    expect(box.memoizedProps?.behavior).toBe("padding");
    expect(box.memoizedProps?.keyboardVerticalOffset).toBe(0);

    const style = StyleSheet.flatten(composer.props.style);
    expect(style.paddingBottom).toBe(42);
  });

  it("KIN-MOBILE-001 R4: a zero-inset device keeps the compact 12/24 shape", async () => {
    const screen = await render(withInsets(0, 0));

    const header = screen.getByTestId("conversation:header");
    expect(StyleSheet.flatten(header.props.style).paddingTop).toBe(12);

    const composer = screen.getByTestId("conversation:composerBar");
    expect(StyleSheet.flatten(composer.props.style).paddingBottom).toBe(24);
  });
});
