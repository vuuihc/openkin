import { describe, expect, it, jest } from "@jest/globals";
import { fireEvent, render } from "@testing-library/react-native";
import { StyleSheet } from "react-native";
import type {
  ProviderEntry,
  ProvidersView,
  UsageRow,
} from "../providers/providersModel";
import { t } from "../i18n";
import ProviderUsageSheet from "./ProviderUsageSheet";
import { SHEET_DISMISS_DISTANCE } from "./sheetDrag";

/**
 * KIN-MOBILE-001 R6 — the provider/usage sheet's pull-down dismissal.
 *
 * Every iOS sheet answers a downward drag, so the signed row
 * (`KIN-MOBILE-001.md:124`) requires 下拉关闭 alongside the existing button and
 * scrim closes. The drag lives on a 44pt grabber strip above the embedded
 * scroller, never on the card: a responder on the card would fight the
 * `ProviderUsage` ScrollView.
 *
 * The strip is driven by plain responder props (no gesture dependency). These
 * cases fire grant/move/release/terminate the way the platform does and count
 * `onClose` calls; the sheet is rendered directly, so no fetch, Keychain or
 * conversation is involved.
 */

const PROVIDER: ProviderEntry = {
  id: "provider-primary",
  name: "Primary provider",
  kind: "openai-compatible",
  base_url: "https://llm.example.com/v1",
  model: "primary-large",
  stream: true,
  active: true,
};

function usageRow(overrides: Partial<UsageRow> = {}): UsageRow {
  return {
    date: "2026-11-20",
    agent: "planner",
    tasks: 2,
    tokens_in: 1000,
    tokens_out: 500,
    cost_usd: 0.03,
    request_count: 4,
    reasoning_output_tokens: 0,
    cache_read_tokens: 300,
    cache_write_tokens: 0,
    cache_eligible_input_tokens: 1200,
    cache_hit_rate: 0.25,
    cache_coverage: 1,
    cache_status: "reported",
    ...overrides,
  };
}

/** A ready view with one provider and one usage row: the resting sheet. */
const VIEW: ProvidersView = {
  status: "ready",
  days: 30,
  providers: [PROVIDER],
  usage: [usageRow()],
};

async function renderSheet() {
  const onClose = jest.fn();
  const screen = await render(
    <ProviderUsageSheet
      onClose={onClose}
      onRefresh={jest.fn()}
      onSelectWindow={jest.fn()}
      state={VIEW}
      t={t}
      visible
    />,
  );
  return { screen, onClose };
}

/** One finger travel: grant at `from`, move to `to`, release at `to`. */
async function drag(
  screen: Awaited<ReturnType<typeof renderSheet>>["screen"],
  from: number,
  to: number,
) {
  // The strip is deliberately hidden from the reader, so RNTL's default
  // accessibility filter skips it; the finger can still reach it.
  const handle = screen.getByTestId("usage-drag-handle", {
    includeHiddenElements: true,
  });
  await fireEvent(handle, "responderGrant", { nativeEvent: { pageY: from } });
  await fireEvent(handle, "responderMove", { nativeEvent: { pageY: to } });
  await fireEvent(handle, "responderRelease", { nativeEvent: { pageY: to } });
}

describe("KIN-MOBILE-001 R6 provider/usage sheet pull-down", () => {
  it("KIN-MOBILE-001 R6: dragging the sheet handle down past the threshold closes it once", async () => {
    const { screen, onClose } = await renderSheet();
    await drag(screen, 300, 300 + SHEET_DISMISS_DISTANCE + 24);
    expect(onClose).toHaveBeenCalledTimes(1);
  });

  it("KIN-MOBILE-001 R6: a short downward drag springs back and leaves the sheet open", async () => {
    const { screen, onClose } = await renderSheet();
    await drag(screen, 300, 300 + SHEET_DISMISS_DISTANCE - 24);
    expect(onClose).not.toHaveBeenCalled();
    expect(screen.getByTestId("usage-card")).toBeTruthy();
  });

  it("KIN-MOBILE-001 R6: an upward drag on the handle never closes the sheet", async () => {
    const { screen, onClose } = await renderSheet();
    // A long upward pull is clamped: the sheet must not lift or dismiss.
    await drag(screen, 500, 120);
    expect(onClose).not.toHaveBeenCalled();
    expect(screen.getByTestId("usage-card")).toBeTruthy();
  });

  it("KIN-MOBILE-001 R6: a cancelled gesture neither closes the sheet nor leaves it displaced", async () => {
    const { screen, onClose } = await renderSheet();
    const handle = screen.getByTestId("usage-drag-handle", {
      includeHiddenElements: true,
    });
    const far = 300 + SHEET_DISMISS_DISTANCE + 40;
    await fireEvent(handle, "responderGrant", { nativeEvent: { pageY: 300 } });
    await fireEvent(handle, "responderMove", { nativeEvent: { pageY: far } });
    // The system took the touch (e.g. an incoming call): the drag is over.
    await fireEvent(handle, "responderTerminate", {
      nativeEvent: { pageY: far },
    });
    expect(onClose).not.toHaveBeenCalled();
    expect(screen.getByTestId("usage-card")).toBeTruthy();
    // The cancel reset the gesture, so a release that still reports the far
    // position must not dismiss: the sheet is back at rest.
    await fireEvent(handle, "responderRelease", {
      nativeEvent: { pageY: far },
    });
    expect(onClose).not.toHaveBeenCalled();
  });

  it("KIN-MOBILE-001 R6: the close button and the scrim still close the sheet", async () => {
    const byButton = await renderSheet();
    await fireEvent.press(byButton.screen.getByTestId("usage-close"));
    expect(byButton.onClose).toHaveBeenCalledTimes(1);

    const byScrim = await renderSheet();
    // The card is accessibilityViewIsModal, so RNTL (like iOS) hides its
    // siblings from the reader; the scrim is still a physical tap target.
    await fireEvent.press(
      byScrim.screen.getByTestId("usage-sheet-scrim", {
        includeHiddenElements: true,
      }),
    );
    expect(byScrim.onClose).toHaveBeenCalledTimes(1);
  });

  it("KIN-MOBILE-001 R6: the drag strip is at least 44 points tall and hidden from the reader", async () => {
    const { screen } = await renderSheet();
    const handle = screen.getByTestId("usage-drag-handle", {
      includeHiddenElements: true,
    });
    const style = StyleSheet.flatten(handle.props.style);
    expect(style.height).toBeGreaterThanOrEqual(44);
    // Decorative: the existing 关闭 button stays the only announced dismiss.
    expect(handle.props.accessibilityElementsHidden).toBe(true);
    expect(handle.props.importantForAccessibility).toBe("no-hide-descendants");

    // The affordance inside the finger target is the signed 36x5 bar.
    const bar = screen.getByTestId("usage-drag-bar", {
      includeHiddenElements: true,
    });
    const barStyle = StyleSheet.flatten(bar.props.style);
    expect(barStyle.width).toBe(36);
    expect(barStyle.height).toBe(5);
  });
});
