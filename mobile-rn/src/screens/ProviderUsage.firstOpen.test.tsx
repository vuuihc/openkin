import { beforeEach, describe, expect, it, jest } from "@jest/globals";
import { fireEvent, render } from "@testing-library/react-native";
import { focusNode } from "../a11y/focus";
import { t as translate } from "../i18n";
import type {
  ProviderEntry,
  ProvidersView,
  UsageRow,
} from "../providers/providersModel";
import ProviderUsage from "./ProviderUsage";
import ProviderUsageSheet from "./ProviderUsageSheet";

/**
 * KIN-MOBILE-001 R6 — the usage sheet's first open.
 *
 * Two signed §7 cells own this suite (`KIN-MOBILE-001.md:123-124`): the slow
 * state is a sheet skeleton with 关闭 always usable, and the sheet is modal, so
 * the reader's focus enters its title. The model's opening view is `loading`
 * with both lists empty (`providersModel.ts:172-177`), which is exactly the
 * first open; a refresh keeps the rows it already had and must not cover them
 * with placeholders.
 *
 * The skeleton is decorative: one spoken loading word, no role, no handler.
 * `focusNode` is mocked like `Approvals.test.tsx:15` so the assertion is about
 * which node the screen asks for, not about a native call.
 */

jest.mock("../a11y/focus", () => ({ focusNode: jest.fn(() => true) }));

const focusMock = jest.mocked(focusNode);

const t = (key: string): string => key;

const PROVIDER: ProviderEntry = {
  id: "provider-primary",
  name: "Primary fixture",
  kind: "openai-compatible",
  base_url: "https://llm.example.com/v1",
  model: "fixture-large",
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

/** The model's opening view: a first read in flight, nothing read yet. */
const FIRST_READ: ProvidersView = {
  status: "loading",
  days: 30,
  providers: [],
  usage: [],
};

/** A settled read: the sheet has numbers and rows to draw. */
const SETTLED: ProvidersView = {
  status: "ready",
  days: 30,
  providers: [PROVIDER],
  usage: [usageRow()],
};

/** A refresh over rows already on screen (`providersModel.ts:202`). */
const REFRESHING: ProvidersView = {
  status: "loading",
  days: 30,
  providers: [PROVIDER],
  usage: [usageRow()],
};

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

describe("KIN-MOBILE-001 R6 usage sheet first open", () => {
  beforeEach(() => {
    focusMock.mockClear();
  });

  it("KIN-MOBILE-001 R6: a first read draws the usage skeleton instead of a bare caption", async () => {
    const screen = await render(
      <ProviderUsage onSelectWindow={() => {}} state={FIRST_READ} t={t} />,
    );

    expect(screen.getByTestId("usage-skeleton")).toBeTruthy();
    // Four tile-shaped placeholders in the real 2×2 rhythm and three rows.
    // The rows sit in a block hidden from the reader, so only the default
    // query proves they are not reader stops; the pointer view still counts
    // them.
    expect(screen.getAllByTestId("usage-skeleton-tile")).toHaveLength(4);
    expect(screen.queryByTestId("usage-skeleton-bar")).toBeNull();
    expect(
      screen.getAllByTestId("usage-skeleton-bar", {
        includeHiddenElements: true,
      }),
    ).toHaveLength(3);
    // The bare caption this row replaces is gone (old-value assertion).
    expect(screen.queryByText("usage.loading")).toBeNull();
    // The 7/30/90 chips stay real controls beside the placeholder.
    for (const days of [7, 30, 90]) {
      expect(screen.getByTestId(`usage-window:${days}`)).toBeTruthy();
    }
    expect(screen.queryAllByTestId(/^tile:/)).toHaveLength(0);
  });

  it("KIN-MOBILE-001 R6: the skeleton is one spoken loading word and exposes no bars to the reader", async () => {
    const screen = await render(
      <ProviderUsage onSelectWindow={() => {}} state={FIRST_READ} t={t} />,
    );

    const skeleton = screen.getByTestId("usage-skeleton");
    expect(skeleton.props.accessible).toBe(true);
    expect(skeleton.props.accessibilityLabel).toBe("usage.loading");
    expect(skeleton.props.accessibilityRole).toBeUndefined();
    // One stop for the reader, not one per placeholder.
    expect(screen.getAllByLabelText("usage.loading")).toHaveLength(1);
    expect(
      screen.queryByTestId("usage-skeleton-rows"),
    ).toBeNull();
    expect(
      screen.getByTestId("usage-skeleton-rows", { includeHiddenElements: true })
        .props.importantForAccessibility,
    ).toBe("no-hide-descendants");
    for (const bar of screen.getAllByTestId("usage-skeleton-bar", {
      includeHiddenElements: true,
    })) {
      expect(bar.props.accessibilityLabel).toBeUndefined();
      expect(bar.props.accessibilityRole).toBeUndefined();
      expect(bar.props.accessible).not.toBe(true);
    }
  });

  it("KIN-MOBILE-001 R6: 关闭 and the scrim still close the sheet while the skeleton shows", async () => {
    const onClose = jest.fn();
    const screen = await render(
      <ProviderUsageSheet
        onClose={onClose}
        onSelectWindow={() => {}}
        state={FIRST_READ}
        t={t}
        visible
      />,
    );

    expect(screen.getByTestId("usage-skeleton")).toBeTruthy();
    // 关闭始终可用 while the read is in flight (`KIN-MOBILE-001.md:123`).
    await fireEvent.press(screen.getByTestId("usage-close"));
    expect(onClose).toHaveBeenCalledTimes(1);
    // The scrim is a pointer target outside the modal card, so the reader
    // never stops on it; a finger still closes the sheet with it.
    await fireEvent.press(
      screen.getByTestId("usage-sheet-scrim", { includeHiddenElements: true }),
    );
    expect(onClose).toHaveBeenCalledTimes(2);
  });

  it("KIN-MOBILE-001 R6: opening the sheet moves reader focus to its title once", async () => {
    await render(
      <ProviderUsageSheet
        onClose={() => {}}
        onSelectWindow={() => {}}
        state={FIRST_READ}
        t={t}
        visible
      />,
    );

    expect(focusMock).toHaveBeenCalledTimes(1);
    const props = focusedNodeProps();
    expect(props?.testID).toBe("usage-title");
    expect(props?.accessibilityRole).toBe("header");
  });

  it("KIN-MOBILE-001 R6: a settled sheet draws no skeleton and takes no focus", async () => {
    // The screen on its own never moves the reader: the sheet asks for focus.
    const standalone = await render(
      <ProviderUsage onSelectWindow={() => {}} state={SETTLED} t={t} />,
    );
    expect(standalone.queryByTestId("usage-skeleton")).toBeNull();
    expect(focusMock).not.toHaveBeenCalled();

    const sheet = await render(
      <ProviderUsageSheet
        onClose={() => {}}
        onSelectWindow={() => {}}
        state={SETTLED}
        t={t}
        visible
      />,
    );
    expect(sheet.queryByTestId("usage-skeleton")).toBeNull();
    expect(sheet.getByTestId("tile:spend")).toBeTruthy();
    expect(sheet.getByTestId("provider:provider-primary")).toBeTruthy();
  });

  it("KIN-MOBILE-001 R6: a failed first read draws the failure block and its retry, not a skeleton", async () => {
    const onRefresh = jest.fn();
    const screen = await render(
      <ProviderUsage
        onRefresh={onRefresh}
        onSelectWindow={() => {}}
        state={{
          status: "failed",
          days: 30,
          providers: [],
          usage: [],
          error: { reason: "rejected", stale: false },
        }}
        t={t}
      />,
    );

    expect(screen.getByText("pairing.rejected")).toBeTruthy();
    expect(screen.getByTestId("usage-retry")).toBeTruthy();
    expect(screen.queryByTestId("usage-skeleton")).toBeNull();
    expect(screen.queryAllByTestId(/^tile:/)).toHaveLength(0);

    await fireEvent.press(screen.getByTestId("usage-retry"));
    expect(onRefresh).toHaveBeenCalledTimes(1);
  });

  it("KIN-MOBILE-001 R6: the caption is gone from a first load", async () => {
    // The real catalogue, not the identity stub: the old sentence was a bare
    // `usage.loading` text node, and this row replaces it with the skeleton.
    const loadingWord = translate("usage.loading");
    const screen = await render(
      <ProviderUsage
        onSelectWindow={() => {}}
        state={FIRST_READ}
        t={translate}
      />,
    );

    expect(screen.getByTestId("usage-skeleton").props.accessibilityLabel).toBe(
      loadingWord,
    );
    expect(screen.queryByText(loadingWord)).toBeNull();
  });

  it("KIN-MOBILE-001 R6: a refresh over kept numbers keeps them instead of covering them with a skeleton", async () => {
    const screen = await render(
      <ProviderUsage onSelectWindow={() => {}} state={REFRESHING} t={t} />,
    );

    expect(screen.queryByTestId("usage-skeleton")).toBeNull();
    expect(screen.getByTestId("tile:spend")).toBeTruthy();
    expect(screen.getByTestId("provider:provider-primary")).toBeTruthy();
  });
});
