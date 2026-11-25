import { describe, expect, it, jest } from "@jest/globals";
import { fireEvent, render, within } from "@testing-library/react-native";
import { StyleSheet } from "react-native";
import {
  cacheRateLabel,
  formatTokenCount,
  summarizeUsage,
} from "../../../ui/src/lib/usage";
import type {
  ProviderEntry,
  ProvidersView,
  UsageRow,
} from "../providers/providersModel";
import ProviderUsage from "./ProviderUsage";

/**
 * KIN-MOBILE-001 R6 — the provider/usage screen, phone presentation.
 *
 * The view state is hand-built from the R6 model's own types, so these rows are
 * about presentation: the four headline tiles folded by the shared formatter,
 * the 7/30/90 window chips, the read-only provider list, the 44pt floor, and
 * the non-ready states. Reads, the window kept in session memory and the
 * late-answer drop are proven in `providersModel.test.ts`.
 *
 * The tile expectations come from `summarizeUsage` itself, not from numbers
 * typed a second time here: a shift in the shared fold must reach this screen
 * without an edit in this file.
 */

const t = (key: string): string => key;

const TILE_KEYS = ["spend", "tokens", "cache", "tasks"] as const;
type TileKey = (typeof TILE_KEYS)[number];

function row(overrides: Partial<UsageRow> = {}): UsageRow {
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

/** Two days: $0.06, 2.0k tokens, 3 tasks, 500/2000 cache (25%). */
const THIRTY_DAY_ROWS: UsageRow[] = [
  row({ date: "2026-11-20" }),
  row({
    date: "2026-11-21",
    tasks: 1,
    tokens_in: 300,
    tokens_out: 200,
    cost_usd: 0.03,
    request_count: 2,
    cache_read_tokens: 200,
    cache_eligible_input_tokens: 800,
  }),
];

/** A larger 90-day window: every tile must move off the 30-day fold. */
const NINETY_DAY_ROWS: UsageRow[] = [
  ...THIRTY_DAY_ROWS,
  row({
    date: "2026-09-01",
    tasks: 5,
    tokens_in: 5000,
    tokens_out: 3000,
    cost_usd: 0.12,
    request_count: 10,
    cache_read_tokens: 4000,
    cache_eligible_input_tokens: 8000,
  }),
];

const PROVIDERS: ProviderEntry[] = [
  {
    id: "provider-primary",
    name: "Primary fixture",
    kind: "openai-compatible",
    base_url: "https://llm.example.com/v1",
    model: "fixture-large",
    stream: true,
    active: true,
  },
  {
    id: "provider-fast",
    name: "Fast fixture",
    kind: "openai-compatible",
    base_url: "https://llm.example.com/v1",
    model: "fixture-small",
    stream: false,
    active: false,
  },
];

function view(overrides: Partial<ProvidersView> = {}): ProvidersView {
  return {
    status: "ready",
    days: 30,
    providers: PROVIDERS,
    usage: THIRTY_DAY_ROWS,
    ...overrides,
  };
}

/** The shared fold, rendered the way the screen's display rules render it. */
function foldValue(rows: UsageRow[], key: TileKey): string {
  const totals = summarizeUsage(rows);
  switch (key) {
    case "spend":
      // `formatCost` is the web client's display rule (ui/src/api/client.ts:2832);
      // it is not in the shared fold, so the test restates its two branches.
      return `$${totals.cost.toFixed(3)}`;
    case "tokens":
      return formatTokenCount(totals.tokens);
    case "cache":
      return cacheRateLabel(
        totals.cacheStatus,
        totals.cacheEligible > 0
          ? totals.cacheRead / totals.cacheEligible
          : null,
      );
    default:
      return String(totals.tasks);
  }
}

type Screen = Awaited<ReturnType<typeof render>>;

function tileValue(screen: Screen, key: TileKey, rows: UsageRow[]): string {
  const tile = screen.getByTestId(`tile:${key}`);
  const value = within(tile).getByText(foldValue(rows, key));
  return String(value.props.children);
}

/** The 44pt floor every pressable control must carry (TASTE 11). */
function expectTouchFloor(screen: Screen, id: string): void {
  const style = StyleSheet.flatten(screen.getByTestId(id).props.style);
  expect(style.minHeight ?? 0).toBeGreaterThanOrEqual(44);
  expect(style.minWidth ?? 0).toBeGreaterThanOrEqual(44);
}

describe("KIN-MOBILE-001 R6 provider/usage screen", () => {
  it("KIN-MOBILE-001 R6: switching the 7/30/90 window redraws the shared formatter's numbers", async () => {
    const onSelectWindow = jest.fn();
    const state = view();
    const screen = await render(
      <ProviderUsage onSelectWindow={onSelectWindow} state={state} t={t} />,
    );

    for (const key of TILE_KEYS) {
      expect(tileValue(screen, key, THIRTY_DAY_ROWS)).toBe(
        foldValue(THIRTY_DAY_ROWS, key),
      );
    }
    expect(
      screen.getByTestId("usage-window:30").props.accessibilityState?.selected,
    ).toBe(true);

    await fireEvent.press(screen.getByTestId("usage-window:90"));
    expect(onSelectWindow).toHaveBeenCalledTimes(1);
    expect(onSelectWindow).toHaveBeenCalledWith(90);

    await screen.rerender(
      <ProviderUsage
        onSelectWindow={onSelectWindow}
        state={{ ...state, days: 90, usage: NINETY_DAY_ROWS }}
        t={t}
      />,
    );

    for (const key of TILE_KEYS) {
      const next = foldValue(NINETY_DAY_ROWS, key);
      // A tile that does not move would let a stale window pass this row.
      expect(next).not.toBe(foldValue(THIRTY_DAY_ROWS, key));
      expect(tileValue(screen, key, NINETY_DAY_ROWS)).toBe(next);
    }
    expect(
      screen.getByTestId("usage-window:90").props.accessibilityState?.selected,
    ).toBe(true);
  });

  it("KIN-MOBILE-001 R6: a device with no usage says so in words instead of a zero", async () => {
    const device = await render(
      <ProviderUsage
        onSelectWindow={() => {}}
        state={view({ status: "empty", providers: [], usage: [] })}
        t={t}
      />,
    );
    expect(device.getByText("agents.emptyUsage")).toBeTruthy();
    expect(device.getByText("agents.emptyUsageHint")).toBeTruthy();
    expect(device.queryAllByText("$0.000")).toHaveLength(0);
    expect(device.queryAllByText("$0.00")).toHaveLength(0);
    expect(device.queryAllByTestId(/^tile:/)).toHaveLength(0);

    const quiet = await render(
      <ProviderUsage
        onSelectWindow={() => {}}
        state={view({ status: "ready", usage: [] })}
        t={t}
      />,
    );
    expect(quiet.getByText("Primary fixture")).toBeTruthy();
    // A configured provider with a quiet window: the range line, not the
    // device-level hint (providersModel.ts:252-258).
    expect(quiet.getByText("agents.emptyUsage")).toBeTruthy();
    expect(quiet.queryByText("agents.emptyUsageHint")).toBeNull();
    for (const key of TILE_KEYS) {
      expect(
        within(quiet.getByTestId(`tile:${key}`)).getByText("—"),
      ).toBeTruthy();
    }
  });

  it("KIN-MOBILE-001 R6: a failed refresh keeps the last numbers and marks them stale", async () => {
    const onRefresh = jest.fn();
    const screen = await render(
      <ProviderUsage
        onRefresh={onRefresh}
        onSelectWindow={() => {}}
        state={view({
          status: "failed",
          error: { reason: "unreachable", stale: true },
        })}
        t={t}
      />,
    );

    for (const key of TILE_KEYS) {
      expect(tileValue(screen, key, THIRTY_DAY_ROWS)).toBe(
        foldValue(THIRTY_DAY_ROWS, key),
      );
    }
    expect(screen.getByText("agents.intervalFailed")).toBeTruthy();
    expect(screen.getByText("Primary fixture")).toBeTruthy();
    expect(screen.getByText("Fast fixture")).toBeTruthy();

    await fireEvent.press(screen.getByTestId("usage-retry"));
    expect(onRefresh).toHaveBeenCalledTimes(1);
  });

  it("KIN-MOBILE-001 R6: closing hands control back once and the screen owns no navigation", async () => {
    const onClose = jest.fn();
    const screen = await render(
      <ProviderUsage
        onClose={onClose}
        onSelectWindow={() => {}}
        state={view()}
        t={t}
      />,
    );
    await fireEvent.press(screen.getByTestId("usage-close"));
    expect(onClose).toHaveBeenCalledTimes(1);

    const noClose = await render(
      <ProviderUsage onSelectWindow={() => {}} state={view()} t={t} />,
    );
    expect(noClose.queryByTestId("usage-close")).toBeNull();
  });

  it("KIN-MOBILE-001 R6: the provider list is read-only and every control clears 44pt", async () => {
    const screen = await render(
      <ProviderUsage
        onClose={() => {}}
        onRefresh={() => {}}
        onSelectWindow={() => {}}
        state={view({
          status: "failed",
          error: { reason: "rejected", stale: true },
        })}
        t={t}
      />,
    );

    const active = screen.getByTestId("provider:provider-primary");
    expect(within(active).getByText("Primary fixture")).toBeTruthy();
    expect(
      within(active).getByText("fixture-large · openai-compatible"),
    ).toBeTruthy();
    expect(
      within(active).getByText("settings.provider.activeBadge"),
    ).toBeTruthy();

    const inactive = screen.getByTestId("provider:provider-fast");
    expect(within(inactive).getByText("Fast fixture")).toBeTruthy();
    expect(
      within(inactive).getByText("fixture-small · openai-compatible"),
    ).toBeTruthy();
    expect(
      within(inactive).queryByText("settings.provider.activeBadge"),
    ).toBeNull();

    // Read-only: the web row's use / edit / delete controls do not come along
    // (story §7 "不把 provider 配置的编辑带进 RN").
    for (const action of ["edit", "use", "delete"]) {
      expect(screen.queryByText(`settings.provider.${action}`)).toBeNull();
    }

    for (const id of [
      "usage-window:7",
      "usage-window:30",
      "usage-window:90",
      "usage-close",
      "usage-retry",
    ]) {
      expectTouchFloor(screen, id);
    }
  });

  it("KIN-MOBILE-001 R6: loading, offline and an expired token each say something", async () => {
    const close = jest.fn();
    const loading = await render(
      <ProviderUsage
        onClose={close}
        onSelectWindow={() => {}}
        state={view({ status: "loading", usage: [] })}
        t={t}
      />,
    );
    expect(loading.getByText("usage.loading")).toBeTruthy();
    // Closing stays available while the read is in flight (story §7 "关闭始终可用").
    expect(loading.getByTestId("usage-close").props.disabled).not.toBe(true);
    expect(
      loading.getByTestId("usage-close").props.accessibilityState?.disabled,
    ).not.toBe(true);

    const offline = await render(
      <ProviderUsage
        onSelectWindow={() => {}}
        state={view({
          status: "offline",
          error: { reason: "unreachable", stale: true },
        })}
        t={t}
      />,
    );
    for (const key of TILE_KEYS) {
      expect(tileValue(offline, key, THIRTY_DAY_ROWS)).toBe(
        foldValue(THIRTY_DAY_ROWS, key),
      );
    }
    expect(offline.getByText("settings.disconnected")).toBeTruthy();

    const expired = await render(
      <ProviderUsage
        onSelectWindow={() => {}}
        state={view({
          status: "failed",
          providers: [],
          usage: [],
          error: { reason: "expired", stale: false },
        })}
        t={t}
      />,
    );
    expect(expired.getByText("pairing.expired")).toBeTruthy();
    // The model cleared the rows on an expired token; the screen must not put
    // a zero or an em-dash tile back in their place.
    expect(expired.queryAllByTestId(/^tile:/)).toHaveLength(0);
    expect(expired.queryAllByText(/^\$/)).toHaveLength(0);
  });

  it("KIN-MOBILE-001 R6: a first read with nothing cached shows its reason instead of em-dash tiles", async () => {
    // The model's opening view (`providersModel.ts:172-177`): both lists are
    // empty until the first read settles, so no tile has anything to show.
    const initial = await render(
      <ProviderUsage
        onSelectWindow={() => {}}
        state={view({ status: "loading", providers: [], usage: [] })}
        t={t}
      />,
    );
    expect(initial.getByText("usage.loading")).toBeTruthy();
    expect(initial.queryAllByTestId(/^tile:/)).toHaveLength(0);

    // A first read that failed kept no rows (`stale: false`), so the notice
    // names the transport reason and no "—" tile stands in for data.
    const rejected = await render(
      <ProviderUsage
        onRefresh={() => {}}
        onSelectWindow={() => {}}
        state={view({
          status: "failed",
          providers: [],
          usage: [],
          error: { reason: "rejected", stale: false },
        })}
        t={t}
      />,
    );
    expect(rejected.getByText("pairing.rejected")).toBeTruthy();
    expect(rejected.queryByText("agents.intervalFailed")).toBeNull();
    expect(rejected.queryAllByTestId(/^tile:/)).toHaveLength(0);

    const offline = await render(
      <ProviderUsage
        onRefresh={() => {}}
        onSelectWindow={() => {}}
        state={view({
          status: "offline",
          providers: [],
          usage: [],
          error: { reason: "unreachable", stale: false },
        })}
        t={t}
      />,
    );
    // "Showing the last values" would be a lie: this read is the first one.
    expect(offline.getByText("pairing.unreachable")).toBeTruthy();
    expect(offline.queryByText("settings.disconnected")).toBeNull();
    expect(offline.queryAllByTestId(/^tile:/)).toHaveLength(0);
  });

  it("KIN-MOBILE-001 R6: a device token still reads its usage tiles", async () => {
    const onRefresh = jest.fn();
    const screen = await render(
      <ProviderUsage
        onRefresh={onRefresh}
        onSelectWindow={() => {}}
        state={view({
          status: "ready",
          providers: [],
          providerListError: { reason: "rejected", stale: false },
        })}
        t={t}
      />,
    );

    // The numbers are the sheet's subject and this read has them.
    for (const key of TILE_KEYS) {
      expect(tileValue(screen, key, THIRTY_DAY_ROWS)).toBe(
        foldValue(THIRTY_DAY_ROWS, key),
      );
    }
    // The reader must not be told the pairing link is invalid: it is not, and
    // re-pairing would not help.
    expect(screen.queryByText("pairing.rejected")).toBeNull();
    expect(screen.queryByTestId("usage-retry")).toBeNull();
    expect(screen.getByTestId("usage-provider-list-error")).toBeTruthy();
    expect(screen.getByText("usage.providerListUnavailable")).toBeTruthy();
  });

  it("KIN-MOBILE-001 R6: the provider rows stay beside the degraded line", async () => {
    const screen = await render(
      <ProviderUsage
        onSelectWindow={() => {}}
        state={view({ providerListError: { reason: "rejected", stale: true } })}
        t={t}
      />,
    );

    expect(screen.getByTestId("provider:provider-primary")).toBeTruthy();
    expect(screen.getByTestId("provider:provider-fast")).toBeTruthy();
    expect(screen.getByTestId("usage-provider-list-error")).toBeTruthy();
    expect(screen.getByText("usage.providerListUnavailable")).toBeTruthy();
  });

  it("KIN-MOBILE-001 R6: a whole-sheet failure still offers the retry", async () => {
    const onRefresh = jest.fn();
    const screen = await render(
      <ProviderUsage
        onRefresh={onRefresh}
        onSelectWindow={() => {}}
        state={view({
          status: "failed",
          error: { reason: "rejected", stale: false },
        })}
        t={t}
      />,
    );

    // The control for the notice path: a failed read keeps the whole-sheet
    // sentence and its retry, and never the section-level line.
    expect(screen.getByText("pairing.rejected")).toBeTruthy();
    expect(screen.getByTestId("usage-retry")).toBeTruthy();
    expect(screen.queryByTestId("usage-provider-list-error")).toBeNull();
    expect(screen.queryByText("usage.providerListUnavailable")).toBeNull();
  });
});
