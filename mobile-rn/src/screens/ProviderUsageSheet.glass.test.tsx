import {
  afterAll,
  afterEach,
  beforeAll,
  beforeEach,
  describe,
  expect,
  it,
  jest,
} from "@jest/globals";
import {
  act,
  fireEvent,
  render,
  waitFor,
} from "@testing-library/react-native";
import { StrictMode } from "react";
import { AccessibilityInfo, StyleSheet } from "react-native";
import { t } from "../i18n";
import { GLASS_FALLBACK_COLOR } from "../native/glass";
import type {
  ProviderEntry,
  ProvidersView,
  UsageRow,
} from "../providers/providersModel";
import ProviderUsageSheet from "./ProviderUsageSheet";
import { SHEET_DISMISS_DISTANCE } from "./sheetDrag";

/**
 * KIN-MOBILE-001 §7 — the usage sheet's glass background.
 *
 * The signed row (`KIN-MOBILE-001.md:122`) says the sheet 「玻璃背景」: the
 * conversation blurs behind the card instead of a flat white panel covering
 * it. The two branches are the `glassFor` contract
 * (`src/native/glass.test.ts`); these cases prove the sheet actually draws
 * the layer, that the card does not paint over it, and that reduced
 * transparency falls back to today's opaque white.
 *
 * The platform read is mocked here, the way `a11y/focus.test.ts` mocks the
 * platform seam: the sheet is rendered directly, so no fetch, Keychain or
 * conversation is involved, and the assertions are about the rendered style,
 * not about iOS.
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

/**
 * The platform's reduced-transparency preference. `AccessibilityInfo` is a
 * real module object, so its two members are spied on rather than the whole
 * of `react-native` being replaced: this suite renders the sheet.
 */
const isReduceTransparencyEnabled = jest.spyOn(
  AccessibilityInfo,
  "isReduceTransparencyEnabled",
);
const addEventListener = jest.spyOn(AccessibilityInfo, "addEventListener");

/** One live `reduceTransparencyChanged` handler per registered reader. */
type TransparencyListener = (enabled: boolean) => void;

/** The remove handle the platform handed back for one registration. */
type TransparencySubscription = { remove: jest.Mock };

function transparencyListeners(): TransparencyListener[] {
  return addEventListener.mock.calls.map(
    (call) => call[1] as unknown as TransparencyListener,
  );
}

function transparencySubscriptions(): TransparencySubscription[] {
  return addEventListener.mock.results.map(
    (result) => result.value as unknown as TransparencySubscription,
  );
}

/**
 * Rejections nobody handled. A platform that cannot answer must fall back to
 * the blur (`GlassSurface.tsx` catches the query); a rejection that escapes is
 * the failure that fallback exists to prevent.
 */
const unhandledRejections: unknown[] = [];
function recordUnhandledRejection(reason: unknown) {
  unhandledRejections.push(reason);
}

beforeAll(() => {
  process.on("unhandledRejection", recordUnhandledRejection);
});
afterAll(() => {
  process.off("unhandledRejection", recordUnhandledRejection);
});

beforeEach(() => {
  unhandledRejections.length = 0;
  // The platform default is an unobstructed surface; the reduced-transparency
  // case overrides it.
  isReduceTransparencyEnabled.mockResolvedValue(false);
  // One handle per registration, so a test can prove each reader stops
  // listening when the sheet goes away.
  addEventListener.mockImplementation(() => ({ remove: jest.fn() }) as never);
});

afterEach(() => {
  jest.clearAllMocks();
});

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

describe("KIN-MOBILE-001 §7 provider/usage sheet glass", () => {
  it("KIN-MOBILE-001 §7: the usage sheet draws a glass surface over the conversation", async () => {
    const { screen } = await renderSheet();

    // The blur is the sheet's background: it fills the card, so the
    // conversation behind the scrim is what tints the surface.
    const card = screen.getByTestId("usage-card");
    expect(screen.getByTestId("glass-blur")).toBeTruthy();
    expect(screen.queryByTestId("glass-opaque")).toBeNull();

    // A card that paints its own background sits on top of the blur and hides
    // it, which is exactly the flat white panel this row replaces.
    const cardStyle = StyleSheet.flatten(card.props.style) as {
      backgroundColor?: string;
    };
    expect(cardStyle.backgroundColor ?? "transparent").toBe("transparent");
  });

  it("KIN-MOBILE-001 §7: reduce transparency swaps the blur for an opaque surface", async () => {
    isReduceTransparencyEnabled.mockResolvedValue(true);
    const { screen } = await renderSheet();

    // The asynchronous platform answer lands after the first paint.
    await waitFor(() => expect(screen.getByTestId("glass-opaque")).toBeTruthy());
    expect(screen.queryByTestId("glass-blur")).toBeNull();

    // The card reaches today's white through the opaque branch, so a reader
    // who asked for reduced transparency keeps the contrast they have now.
    const cardStyle = StyleSheet.flatten(
      screen.getByTestId("usage-card").props.style,
    ) as { backgroundColor?: string };
    expect(cardStyle.backgroundColor).toBe(GLASS_FALLBACK_COLOR);
    const opaqueStyle = StyleSheet.flatten(
      screen.getByTestId("glass-opaque").props.style,
    ) as { backgroundColor?: string };
    expect(opaqueStyle.backgroundColor).toBe(GLASS_FALLBACK_COLOR);
  });

  it("KIN-MOBILE-001 §7: a live preference change swaps the surface and unmount stops listening", async () => {
    const { screen } = await renderSheet();
    const listeners = transparencyListeners();
    const subscriptions = transparencySubscriptions();

    // The sheet and its background layer each read the preference once, so
    // every registration has exactly one handle to remove.
    expect(listeners.length).toBeGreaterThan(0);
    expect(subscriptions.length).toBe(listeners.length);
    expect(screen.getByTestId("glass-blur")).toBeTruthy();

    // iOS announces the reader turning reduced transparency on while the sheet
    // is open: the live handler, not a remount, is what must repaint it.
    await act(async () => {
      listeners.forEach((listener) => listener(true));
    });
    expect(screen.getByTestId("glass-opaque")).toBeTruthy();
    expect(screen.queryByTestId("glass-blur")).toBeNull();

    // And turning it back off restores the blur.
    await act(async () => {
      listeners.forEach((listener) => listener(false));
    });
    expect(screen.getByTestId("glass-blur")).toBeTruthy();
    expect(screen.queryByTestId("glass-opaque")).toBeNull();

    await screen.unmount();

    // A closed sheet that keeps its listener keeps the platform answering a
    // surface nobody sees (AGENTS.md §11).
    subscriptions.forEach((subscription) =>
      expect(subscription.remove).toHaveBeenCalledTimes(1),
    );
  });

  it("KIN-MOBILE-001 §7: a platform that cannot answer keeps the blur", async () => {
    isReduceTransparencyEnabled.mockRejectedValue(
      new Error("accessibility info unavailable"),
    );
    const { screen } = await renderSheet();

    // A failed query is not a preference for opaque: the sheet keeps the
    // default surface and the rejection is handled, not left dangling.
    await waitFor(() => expect(screen.getByTestId("glass-blur")).toBeTruthy());
    expect(screen.queryByTestId("glass-opaque")).toBeNull();
    await new Promise((resolve) => setTimeout(resolve, 0));
    expect(unhandledRejections).toEqual([]);
  });

  it("KIN-MOBILE-001 §7: an answer that lands after the sheet closed is dropped", async () => {
    const answers: Array<(enabled: boolean) => void> = [];
    isReduceTransparencyEnabled.mockImplementation(
      () =>
        new Promise<boolean>((resolve) => {
          answers.push(resolve);
        }),
    );
    const { screen } = await renderSheet();
    expect(screen.getByTestId("glass-blur")).toBeTruthy();

    // The reader closed the sheet while iOS was still answering. The answer
    // belongs to a surface that is gone: resolving it must not throw, warn, or
    // repaint anything (AGENTS.md §11).
    const errors: unknown[][] = [];
    const consoleError = jest
      .spyOn(console, "error")
      .mockImplementation((...args: unknown[]) => {
        errors.push(args);
      });
    try {
      await screen.unmount();
      await act(async () => {
        answers.forEach((answer) => answer(true));
        await Promise.resolve();
      });
      expect(errors).toEqual([]);
      expect(unhandledRejections).toEqual([]);
    } finally {
      consoleError.mockRestore();
    }
  });

  it("KIN-MOBILE-001 §7: an answer from a replaced registration cannot repaint the sheet", async () => {
    const answers: Array<(enabled: boolean) => void> = [];
    isReduceTransparencyEnabled.mockImplementation(
      () =>
        new Promise<boolean>((resolve) => {
          answers.push(resolve);
        }),
    );
    const onClose = jest.fn();
    // StrictMode makes React Native's own `findNodeHandle` path warn on every
    // host view; the warning is about the renderer, not about this sheet.
    const consoleError = jest
      .spyOn(console, "error")
      .mockImplementation(() => {});
    try {
      const screen = await render(
        <ProviderUsageSheet
          onClose={onClose}
          onRefresh={jest.fn()}
          onSelectWindow={jest.fn()}
          state={VIEW}
          t={t}
          visible
        />,
        { wrapper: StrictMode },
      );

      // StrictMode replaces every registration once at mount. The first
      // generation was cleaned up already, so its answer is a late answer even
      // though the sheet is still on screen — the same drop AGENTS.md §11 asks
      // for when the sheet closes mid-query. The sheet and its glass layer are
      // the two readers, so the last two answers are the live generation.
      const replayed = answers.slice(0, -2);
      expect(replayed.length).toBeGreaterThan(0);

      // The live generation answers first: the sheet keeps the default blur.
      await act(async () => {
        answers.slice(-2).forEach((answer) => answer(false));
        await Promise.resolve();
      });
      expect(screen.getByTestId("glass-blur")).toBeTruthy();

      // Then the replaced generation answers "reduced transparency". It must
      // not repaint a surface it no longer speaks for.
      await act(async () => {
        replayed.forEach((answer) => answer(true));
        await Promise.resolve();
      });
      expect(screen.getByTestId("glass-blur")).toBeTruthy();
      expect(screen.queryByTestId("glass-opaque")).toBeNull();
    } finally {
      consoleError.mockRestore();
    }
  });

  it("KIN-MOBILE-001 §7: the glass sheet still dismisses three ways", async () => {
    // The background layer fills the card; it must not become a responder
    // that eats the grabber's drag or the header's close.
    const byScrim = await renderSheet();
    await fireEvent.press(
      byScrim.screen.getByTestId("usage-sheet-scrim", {
        includeHiddenElements: true,
      }),
    );
    expect(byScrim.onClose).toHaveBeenCalledTimes(1);

    const byDrag = await renderSheet();
    const handle = byDrag.screen.getByTestId("usage-drag-handle", {
      includeHiddenElements: true,
    });
    const from = 300;
    const to = from + SHEET_DISMISS_DISTANCE + 24;
    await fireEvent(handle, "responderGrant", { nativeEvent: { pageY: from } });
    await fireEvent(handle, "responderMove", { nativeEvent: { pageY: to } });
    await fireEvent(handle, "responderRelease", { nativeEvent: { pageY: to } });
    expect(byDrag.onClose).toHaveBeenCalledTimes(1);

    const byButton = await renderSheet();
    await fireEvent.press(byButton.screen.getByTestId("usage-close"));
    expect(byButton.onClose).toHaveBeenCalledTimes(1);
  });
});
