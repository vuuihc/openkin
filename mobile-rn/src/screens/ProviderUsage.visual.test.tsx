import { beforeEach, describe, expect, it, jest } from "@jest/globals";
import { fireEvent, render, within } from "@testing-library/react-native";
import type { ComponentProps } from "react";
import {
  StyleSheet,
  useColorScheme,
  type TextStyle,
  type ViewStyle,
} from "react-native";
import { t as realT } from "../i18n";
import type {
  ProviderEntry,
  ProvidersView,
  UsageRow,
} from "../providers/providersModel";
import { palette, radius } from "../theme/tokens";
import ProviderUsage from "./ProviderUsage";
import ProviderUsageSheet from "./ProviderUsageSheet";

/**
 * KIN-MOBILE-002 R6 — the usage sheet's signed visual.
 *
 * The frame (`KIN-MOBILE-002.figma/frames/05-phone-usage-sheet.svg`) is a bottom
 * sheet with a 20pt top radius and grabber, one segmented 本周/30天/90天 control,
 * one row per spending agent (identity dot, right-aligned tabular amount, a
 * proportional bar, a percent + token caption) and a window total. This suite
 * proves that visual at element/style level in both schemes; KIN-MOBILE-001's
 * behaviour (reads, window memory, stale rows, retry, the four headline tiles)
 * is proven in `ProviderUsage.test.tsx` and is only spot-checked here.
 *
 * `useColorScheme` is mocked at the platform module `useTheme()` imports, the
 * same seam `theme.test.ts` uses, so the two schemes are real renders rather
 * than a second palette guess.
 */

jest.mock("react-native/Libraries/Utilities/useColorScheme", () => ({
  __esModule: true,
  default: jest.fn(),
}));

const systemScheme = jest.mocked(useColorScheme) as jest.MockedFunction<
  () => ReturnType<typeof useColorScheme> | undefined
>;

const t = (key: string): string => key;

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

/**
 * Three agents of unequal spend plus one row the node could not price: the
 * frame's resting state. claude-code $30, codex $10, planner null —
 * shares 75% / 25% / 0% of a $40 window.
 */
const ROWS: UsageRow[] = [
  row({ agent: "claude-code", cost_usd: 30, tokens_in: 1000, tokens_out: 500 }),
  row({ agent: "codex", cost_usd: 10, tokens_in: 2000, tokens_out: 1000 }),
  row({ agent: "planner", cost_usd: null, tokens_in: 400, tokens_out: 100 }),
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
];

function view(overrides: Partial<ProvidersView> = {}): ProvidersView {
  return {
    status: "ready",
    days: 30,
    providers: PROVIDERS,
    usage: ROWS,
    ...overrides,
  };
}

type Screen = Awaited<ReturnType<typeof render>>;

/** The rendered style of one testID, flattened the way RN resolves it. */
function style(screen: Screen, id: string, hidden = false): ViewStyle {
  return StyleSheet.flatten(
    screen.getByTestId(
      id,
      hidden ? { includeHiddenElements: true } : undefined,
    ).props.style,
  ) as ViewStyle;
}

function renderScreen(
  overrides: Partial<ProvidersView> = {},
  props: Partial<ComponentProps<typeof ProviderUsage>> = {},
): Promise<Screen> {
  return render(
    <ProviderUsage
      onSelectWindow={() => {}}
      state={view(overrides)}
      t={t}
      {...props}
    />,
  );
}

beforeEach(() => {
  systemScheme.mockReturnValue("dark");
});

describe("KIN-MOBILE-002 R6 usage sheet visual", () => {
  it("KIN-MOBILE-002 R6: the usage rows show identity dots, right-aligned tabular amounts and proportional bars", async () => {
    const screen = await renderScreen();

    // One row per spending agent, in spend order; the configured provider list
    // is a different section and does not become a usage row.
    const rows = screen.getAllByTestId(/^usage-agent:/);
    expect(rows.map((node) => node.props.testID)).toEqual([
      "usage-agent:claude-code",
      "usage-agent:codex",
      "usage-agent:planner",
    ]);

    const row = screen.getByTestId("usage-agent:claude-code");
    // The identity dot is the signed mark and comes from the token layer.
    expect(style(screen, "usage-agent-dot:claude-code", true).backgroundColor).toBe(
      palette.dark.agentClaude,
    );
    expect(style(screen, "usage-agent-dot:codex", true).backgroundColor).toBe(
      palette.dark.agentCodex,
    );
    // An unknown agent is the neutral blue, never an invented colour.
    expect(style(screen, "usage-agent-dot:planner", true).backgroundColor).toBe(
      palette.dark.blue,
    );

    // Name and amount are text, so the row means something without colour.
    expect(within(row).getByText("claude-code")).toBeTruthy();
    const amount = within(row).getByText("$30.000");
    const amountStyle = StyleSheet.flatten(amount.props.style) as TextStyle;
    expect(amountStyle.fontVariant).toContain("tabular-nums");
    expect(amountStyle.textAlign).toBe("right");

    // Every row carries its bar, filled with its own identity colour.
    for (const agent of ["claude-code", "codex", "planner"]) {
      expect(screen.getByTestId(`usage-agent-bar:${agent}`)).toBeTruthy();
    }
    expect(style(screen, "usage-agent-bar:codex").backgroundColor).toBe(
      palette.dark.agentCodex,
    );
    expect(style(screen, "usage-agent-track:codex").backgroundColor).toBe(
      palette.dark.fill,
    );
  });

  it("KIN-MOBILE-002 R6: the bar share matches the cost share of the window total", async () => {
    const screen = await renderScreen();

    // $40 window: claude-code 75%, codex 25%, an unpriced row 0%.
    expect(style(screen, "usage-agent-bar:claude-code").width).toBe("75%");
    expect(style(screen, "usage-agent-bar:codex").width).toBe("25%");
    expect(style(screen, "usage-agent-bar:planner").width).toBe("0%");

    // The caption says the same share and the token detail the frame draws.
    const claude = screen.getByTestId("usage-agent:claude-code");
    expect(
      within(claude).getByText(
        "75% · chat.progress.input 1.0k · chat.progress.output 500",
      ),
    ).toBeTruthy();

    // One window total, composed from existing labels and the same rules.
    expect(screen.getByTestId("usage-window-total").props.children).toBe(
      "usage.spend $40.000 · usage.tokens 5.0k",
    );
  });

  it("KIN-MOBILE-002 R6: the usage caption reads the catalog's labels, never a raw key", async () => {
    // The identity `t` above pins which key the component asks for; this render
    // uses the real adapter, so it pins what a reader sees. A miss returns the
    // path itself (`i18n.ts:50`), which is the defect this case exists for.
    const screen = await renderScreen({}, { t: realT });

    const claude = screen.getByTestId("usage-agent:claude-code");
    expect(within(claude).getByText(/输入/)).toBeTruthy();
    expect(within(claude).getByText(/输出/)).toBeTruthy();
    expect(screen.queryByText(/progress\.(input|output)/)).toBeNull();
  });

  it("KIN-MOBILE-002 R6: 本周/30天/90天 render as one segmented control and keep the existing window callbacks", async () => {
    const onSelectWindow = jest.fn();
    const screen = await renderScreen({}, { onSelectWindow });

    const control = screen.getByTestId("usage-window-control");
    const segments = within(control).getAllByTestId(/^usage-window:/);
    expect(segments.map((node) => node.props.testID)).toEqual([
      "usage-window:7",
      "usage-window:30",
      "usage-window:90",
    ]);

    // The selected segment is the elevated one; the others stay quiet.
    expect(style(screen, "usage-window:30").backgroundColor).toBe(
      palette.dark.elevated,
    );
    expect(style(screen, "usage-window:7").backgroundColor).toBeUndefined();
    expect(style(screen, "usage-window:90").backgroundColor).toBeUndefined();
    expect(
      style(screen, "usage-window:30").minHeight,
    ).toBeGreaterThanOrEqual(44);

    await fireEvent.press(screen.getByTestId("usage-window:7"));
    expect(onSelectWindow).toHaveBeenLastCalledWith(7);
    await fireEvent.press(screen.getByTestId("usage-window:90"));
    expect(onSelectWindow).toHaveBeenLastCalledWith(90);
    expect(screen.getByTestId("usage-window:30").props.accessibilityState).toEqual(
      { selected: true },
    );
  });

  it("KIN-MOBILE-002 R6: the sheet's top radius is 20 and the grabber strip remains a 44pt target", async () => {
    const screen = await render(
      <ProviderUsageSheet
        onClose={() => {}}
        onSelectWindow={() => {}}
        state={view()}
        t={t}
        visible
      />,
    );

    // `mobile-rn/DESIGN.md` and the frame: a sheet's top corner is 20.
    expect(radius.sheet).toBe(20);
    const card = style(screen, "usage-card");
    expect(card.borderTopLeftRadius).toBe(20);
    expect(card.borderTopRightRadius).toBe(20);

    // The pull-down stays a full 44pt strip with the visible bar centred.
    const handle = style(screen, "usage-drag-handle", true);
    expect(handle.height).toBe(44);
    expect(handle.alignItems).toBe("center");
    expect(handle.justifyContent).toBe("center");
    expect(
      screen.getByTestId("usage-drag-bar", { includeHiddenElements: true }),
    ).toBeTruthy();
  });

  it("KIN-MOBILE-002 R6: dark and light schemes paint the control, rows and bars from tokens", async () => {
    for (const scheme of ["dark", "light"] as const) {
      systemScheme.mockReturnValue(scheme);
      const screen = await renderScreen();

      expect(style(screen, "usage-window:30").backgroundColor).toBe(
        palette[scheme].elevated,
      );
      expect(style(screen, "usage-agent-track:codex").backgroundColor).toBe(
        palette[scheme].fill,
      );
      expect(style(screen, "usage-agent-dot:codex", true).backgroundColor).toBe(
        palette[scheme].agentCodex,
      );
      expect(style(screen, "usage-agent-bar:codex").backgroundColor).toBe(
        palette[scheme].agentCodex,
      );
      const name = within(
        screen.getByTestId("usage-agent:codex"),
      ).getByText("codex");
      expect(
        (StyleSheet.flatten(name.props.style) as TextStyle).color,
      ).toBe(palette[scheme].text);

    }
  });

  it("KIN-MOBILE-002 R6: empty, stale, offline and expired states keep their KIN-MOBILE-001 wording and retry", async () => {
    const device = await renderScreen({ status: "empty", providers: [], usage: [] });
    expect(device.getByText("agents.emptyUsageDevice")).toBeTruthy();
    expect(device.getByText("agents.emptyUsageHint")).toBeTruthy();
    expect(device.queryAllByTestId(/^usage-agent:/)).toHaveLength(0);
    expect(device.queryByTestId("usage-window-total")).toBeNull();

    const onRefresh = jest.fn();
    const stale = await renderScreen(
      { status: "failed", error: { reason: "unreachable", stale: true } },
      { onRefresh },
    );
    expect(stale.getByText("agents.intervalFailed")).toBeTruthy();
    // The kept rows still draw their bars over the stale marker.
    expect(stale.getAllByTestId(/^usage-agent:/)).toHaveLength(3);
    await fireEvent.press(stale.getByTestId("usage-retry"));
    expect(onRefresh).toHaveBeenCalledTimes(1);

    const offline = await renderScreen({
      status: "offline",
      error: { reason: "unreachable", stale: true },
    });
    expect(offline.getByText("settings.disconnected")).toBeTruthy();

    const expired = await renderScreen({
      status: "failed",
      providers: [],
      usage: [],
      error: { reason: "expired", stale: false },
    });
    expect(expired.getByText("pairing.expired")).toBeTruthy();
    expect(expired.queryAllByTestId(/^usage-agent:/)).toHaveLength(0);
    expect(expired.queryAllByText(/^\$/)).toHaveLength(0);
  });
});
