import { beforeEach, describe, expect, it, jest } from "@jest/globals";
import { fireEvent, render, within } from "@testing-library/react-native";
import {
  AccessibilityInfo,
  StyleSheet,
  useColorScheme,
  type TextStyle,
  type ViewStyle,
} from "react-native";
import { SafeAreaProvider } from "react-native-safe-area-context";
import type { Approval } from "@ui/api/contract";
import type { ApprovalEntry, ApprovalsState } from "../approvals/approvalsModel";
import { t } from "../i18n";
import { composerBottomInset } from "../native/insets";
import { palette, radius } from "../theme/tokens";
import type { ThreadState } from "../thread/threadModel";
import ConversationView from "./ConversationView";

/**
 * KIN-MOBILE-002 R5 — the composer's signed visual.
 *
 * The frame (`KIN-MOBILE-002.figma/frames/04-phone-composer-approval.svg`) and
 * the story's R5 row (`KIN-MOBILE-002.md:29`) ask for one glass capsule above
 * the home indicator, a circular Send that is filled only while a draft exists,
 * a circular Stop while a round runs, and queued rows that keep their words and
 * their 44pt 撤回 inside the capsule. DESIGN.md:47 adds the screen-level rule:
 * a pending 批准 outranks Send, so Send is not the filled primary then.
 *
 * Element-level styles in both schemes, the same seam
 * `Approvals.visual.test.tsx` and `ProviderUsage.visual.test.tsx` use; the
 * behaviour behind these controls (queueing, withdrawing, stopping) stays
 * pinned by `Conversation.test.tsx`.
 */

jest.mock("react-native/Libraries/Utilities/useColorScheme", () => ({
  __esModule: true,
  default: jest.fn(),
}));

/**
 * The liquid-glass view is only drawn on iOS 26 and only by the composer; the
 * mock keeps that branch renderable without the native module, and every other
 * suite that renders `GlassSurface` never reaches the lazy import.
 */
jest.mock("expo-glass-effect", () => ({
  __esModule: true,
  GlassView: "GlassView",
}));

const systemScheme = jest.mocked(useColorScheme) as jest.MockedFunction<
  () => ReturnType<typeof useColorScheme> | undefined
>;

const isReduceTransparencyEnabled = jest.spyOn(
  AccessibilityInfo,
  "isReduceTransparencyEnabled",
);
const addEventListener = jest.spyOn(AccessibilityInfo, "addEventListener");

const TASK_ID = "task-composer";

type View = Awaited<ReturnType<typeof render>>;
type ViewProps = Partial<Parameters<typeof ConversationView>[0]>;

function state(overrides: Partial<ThreadState> = {}): ThreadState {
  return {
    taskId: TASK_ID,
    title: "Composer capsule",
    status: "ready",
    turns: [],
    running: false,
    sendQueue: [],
    banner: null,
    reason: null,
    ...overrides,
  };
}

function approval(id: string): Approval {
  return {
    id,
    task_id: TASK_ID,
    kind: "tool_use",
    payload: { tool_name: "Bash", input: { command: "ls -la" } },
    decision: "pending",
    created_at: 1,
  };
}

function pendingApproval(): ApprovalsState {
  const record = approval("a1");
  const entry: ApprovalEntry = {
    key: "approval:a1",
    kind: "approval",
    id: record.id,
    createdAt: record.created_at,
    approval: record,
    phase: "idle",
    pending: true,
  };
  return {
    status: "ready",
    items: [entry],
    pendingCount: 1,
    online: true,
    revision: 1,
  };
}

function element(extra: ViewProps = {}) {
  return (
    <ConversationView onBack={jest.fn()} state={state()} t={t} {...extra} />
  );
}

/** The conversation on a device reporting a 34pt home indicator. */
function renderView(extra: ViewProps = {}): Promise<View> {
  return render(
    <SafeAreaProvider
      initialMetrics={{
        frame: { x: 0, y: 0, width: 390, height: 844 },
        insets: { top: 0, left: 0, right: 0, bottom: 34 },
      }}
    >
      {element(extra)}
    </SafeAreaProvider>,
  );
}

function style(view: View, id: string): ViewStyle {
  return StyleSheet.flatten(view.getByTestId(id).props.style) as ViewStyle;
}

function labelStyle(view: View, id: string, text: string): TextStyle {
  return StyleSheet.flatten(
    within(view.getByTestId(id)).getByText(text).props.style,
  ) as TextStyle;
}

beforeEach(() => {
  jest.clearAllMocks();
  systemScheme.mockReturnValue("light");
  isReduceTransparencyEnabled.mockResolvedValue(false);
  addEventListener.mockImplementation(() => ({ remove: jest.fn() }) as never);
});

describe("KIN-MOBILE-002 R5 composer capsule visual", () => {
  it("KIN-MOBILE-002 R5: the composer is one capsule on the composer radius above the home indicator", async () => {
    for (const scheme of ["light", "dark"] as const) {
      systemScheme.mockReturnValue(scheme);
      const view = await renderView({ onSend: jest.fn() });
      const bar = view.getByTestId("conversation:composerBar");
      const barStyle = style(view, "conversation:composerBar");

      // One capsule at the signed 22pt radius (DESIGN.md:39), a single
      // hairline all round and no top border — the flat strip this replaces.
      expect(barStyle.borderRadius).toBe(radius.composer);
      expect(barStyle.borderWidth).toBe(StyleSheet.hairlineWidth);
      expect(barStyle.borderColor).toBe(palette[scheme].hairlineStrong);
      expect(barStyle.borderTopWidth).toBeUndefined();
      expect(barStyle.overflow).toBe("hidden");
      expect(barStyle.marginHorizontal).toBe(16);

      // The surface is glass, not paint: the bar stays transparent and the
      // glass layer behind it is what the reader sees (the header's switch).
      expect(barStyle.backgroundColor).toBe("transparent");
      expect(within(bar).getByTestId(/^glass-/)).toBeTruthy();

      // It floats: the safe-area clearance stays outside the capsule, plus the
      // 8pt of air that keeps it off the home indicator.
      const dock = style(view, "conversation:composerDock");
      expect(dock.paddingBottom).toBe(composerBottomInset(34));
      expect(barStyle.marginBottom).toBe(8);

      // The queue's rhythm lives inside the capsule (asserted with its rows).
      expect(barStyle.paddingHorizontal).toBe(16);
      expect(barStyle.paddingVertical).toBe(12);
    }
  });

  it("KIN-MOBILE-002 R5: Send is a 44pt circle, filled only while a draft exists", async () => {
    const onSend = jest.fn();
    const view = await renderView({ onSend });

    // The empty draft: a 44pt circle, no fill, brand ink.
    const empty = style(view, "conversation:send");
    expect(empty.width).toBe(44);
    expect(empty.height).toBe(44);
    expect(empty.borderRadius).toBe(radius.composer);
    expect(empty.backgroundColor).toBe("transparent");
    const emptyLabel = labelStyle(view, "conversation:send", t("composer.send"));
    expect(emptyLabel.color).toBe(palette.light.blueInk);
    expect(emptyLabel.fontSize).toBe(13);

    // A draft makes it the screen's filled primary: brand fill, on-brand ink.
    await fireEvent.changeText(
      view.getByTestId("conversation:composer"),
      "ship the capsule",
    );
    const filled = style(view, "conversation:send");
    expect(filled.backgroundColor).toBe(palette.light.blue);
    const filledLabel = labelStyle(view, "conversation:send", t("composer.send"));
    expect(filledLabel.color).toBe(palette.light.onBrand);
    expect(filledLabel.fontSize).toBe(13);

    // And it still sends.
    await fireEvent.press(view.getByTestId("conversation:send"));
    expect(onSend).toHaveBeenCalledWith("ship the capsule");
  });

  it("KIN-MOBILE-002 R5: a pending approval keeps Send outlined even with a draft", async () => {
    const onSend = jest.fn();
    const view = await renderView({
      approvals: {
        onAnswer: jest.fn(),
        onApprove: jest.fn(),
        onDeny: jest.fn(),
        state: pendingApproval(),
        t,
      },
      onSend,
    });

    await fireEvent.changeText(
      view.getByTestId("conversation:composer"),
      "still send this",
    );

    // One filled primary per screen (DESIGN.md:47): 批准 owns it, so Send
    // keeps its outline — but it is not hidden and still works.
    const send = style(view, "conversation:send");
    expect(send.backgroundColor).toBe("transparent");
    expect(
      labelStyle(view, "conversation:send", t("composer.send")).color,
    ).toBe(palette.light.blueInk);
    expect(view.getByTestId("conversation:send").props.accessibilityState).toEqual(
      { disabled: false, busy: false },
    );

    await fireEvent.press(view.getByTestId("conversation:send"));
    expect(onSend).toHaveBeenCalledWith("still send this");
  });

  it("KIN-MOBILE-002 R5: a running round adds a 44pt circular Stop beside Send", async () => {
    const view = await renderView({
      onSend: jest.fn(),
      onStop: jest.fn(),
      state: state({ running: true }),
    });

    const stop = style(view, "conversation:stop");
    expect(stop.width).toBe(44);
    expect(stop.height).toBe(44);
    expect(stop.borderRadius).toBe(radius.composer);
    expect(stop.backgroundColor).toBe("transparent");
    expect(stop.borderWidth).toBe(StyleSheet.hairlineWidth);
    expect(stop.borderColor).toBe(palette.light.hairlineStrong);
    const stopLabel = labelStyle(view, "conversation:stop", t("composer.stop"));
    expect(stopLabel.color).toBe(palette.light.redInk);
    expect(stopLabel.fontSize).toBe(13);

    // Queue-while-running is signed behaviour: Send stays present beside Stop.
    expect(view.getByTestId("conversation:send")).toBeTruthy();
  });

  it("KIN-MOBILE-002 R5: a queued row keeps its words, its queued label and a 44pt withdraw inside the capsule", async () => {
    const view = await renderView({
      onSend: jest.fn(),
      onWithdraw: jest.fn(),
      state: state({ sendQueue: [{ id: "q1", text: "then run the lint" }] }),
    });

    const bar = view.getByTestId("conversation:composerBar");
    expect(within(bar).getByText(t("chat.queued"))).toBeTruthy();
    expect(within(bar).getByText("then run the lint")).toBeTruthy();

    // The withdraw stays the signed 44pt target inside the capsule.
    const withdraw = style(view, "conversation:withdraw:q1");
    expect(withdraw.minHeight).toBeGreaterThanOrEqual(44);
    expect(withdraw.minWidth).toBeGreaterThanOrEqual(44);

    // The rows keep the capsule's 16pt rhythm with 6pt between them.
    expect(style(view, "conversation:queue").gap).toBe(6);
    expect(style(view, "conversation:composerBar").paddingHorizontal).toBe(16);
  });
});
