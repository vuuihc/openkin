import {
  afterEach,
  beforeEach,
  describe,
  expect,
  it,
  jest,
} from "@jest/globals";
import {
  fireEvent,
  render,
  within,
} from "@testing-library/react-native";
import { StyleSheet, useColorScheme } from "react-native";
import { palette } from "../theme/tokens";
import ConversationList, {
  ROW_HEIGHT,
  ROW_MIN_HEIGHT,
} from "./ConversationList";
import { t as realT } from "../i18n";
import {
  buildListGroups,
  type ConversationRow,
  type DeviceGroup,
  type ListViewState,
} from "../list/listModel";
import type { Task } from "../../../ui/src/api/contract";

/**
 * KIN-MOBILE-002 R3 — the list reads as an iOS grouped list.
 *
 * The acceptance file for the story's R3 row: every conversation row carries
 * the design's shape + colour status mark, the hairlines are inset, the search
 * field moved into the navigation bar, and the four states paint from the
 * scheme. Behaviour (ordering, folding, search folding, focus, scroll memory)
 * stays KIN-MOBILE-001's and is proven in the suites beside this one; the last
 * case here re-renders through the new layout to prove it did not move.
 *
 * `useColorScheme` is mocked at the platform module the hook imports, exactly
 * as `theme.test.ts` does, so the dark and light reads are the real palettes.
 */

jest.mock("react-native/Libraries/Utilities/useColorScheme", () => ({
  __esModule: true,
  default: jest.fn(),
}));

const systemScheme = jest.mocked(useColorScheme) as jest.MockedFunction<
  () => ReturnType<typeof useColorScheme> | undefined
>;

const t = (key: string): string => key;

/** The catalogue word for a task status, the way the screen asks for it. */
const STATUS_KEY: Record<string, string> = {
  running: "sessions.statusRunning",
  waiting_approval: "sessions.statusWaitingApproval",
  waiting_input: "sessions.statusWaitingInput",
  succeeded: "sessions.statusSucceeded",
  failed: "sessions.statusFailed",
  canceled: "sessions.statusCanceled",
};

function row(
  id: string,
  title: string,
  at: number,
  status: string | null,
  pending = 0,
): ConversationRow {
  return {
    id,
    title,
    agentId: "kin",
    at,
    timeLabel: `t${at}`,
    statusKey: status === null ? null : (STATUS_KEY[status] ?? null),
    status,
    pending,
    remote: false,
  };
}

/** A mixed list: running, failed, done and a waiting approval with a count. */
function groups(): DeviceGroup[] {
  return [
    {
      id: "dev-a",
      label: "Laptop",
      isSelf: true,
      online: true,
      count: 5,
      projects: [
        {
          key: "/work/alpha",
          label: "Alpha",
          open: true,
          lastActivityAt: 1000,
          rows: [
            row("a1", "a1 title", 1000, "running"),
            row("a2", "a2 title", 900, "failed"),
            row("a3", "a3 title", 800, "succeeded"),
            row("a4", "a4 title", 700, "waiting_approval", 2),
          ],
        },
        {
          key: "/work/beta",
          label: "Beta",
          open: false,
          lastActivityAt: 600,
          rows: [row("b1", "b1 title", 600, "canceled")],
        },
      ],
    },
  ];
}

function state(overrides: Partial<ListViewState> = {}): ListViewState {
  return { status: "ready", groups: groups(), error: null, ...overrides };
}

function listProps(
  overrides: Partial<Parameters<typeof ConversationList>[0]> = {},
): Parameters<typeof ConversationList>[0] {
  return {
    onOpen: () => {},
    onQueryChange: () => {},
    onRefresh: () => {},
    query: "",
    state: state(),
    t,
    ...overrides,
  };
}

/** The shape a row's mark paints: its child view carries the colour. */
type Screen = Awaited<ReturnType<typeof render>>;

function markShape(screen: Screen, rowId: string): ReturnType<typeof within> {
  // The mark hides itself from the screen reader, so the query opts in to
  // hidden elements: decorative is not absent.
  return within(
    within(screen.getByTestId(`row:${rowId}`)).getByTestId("row-mark", {
      includeHiddenElements: true,
    }),
  );
}

beforeEach(() => {
  systemScheme.mockReturnValue("light");
});

afterEach(() => {
  jest.clearAllMocks();
});

/** One task, shaped exactly as `/api/tasks` answers it. */
function task(): Task {
  return {
    id: "a1",
    title: "a1 title",
    agent: "kin",
    cwd: "/work/alpha",
    prompt: "hello",
    model: "model-x",
    status: "running",
    tokens_in: 0,
    tokens_out: 0,
    created_at: 1000,
    started_at: 1000,
    finished_at: null,
    executing_device_id: "dev-a",
    event_epoch: 0,
  };
}

describe("KIN-MOBILE-002 R3 grouped list", () => {
  it("KIN-MOBILE-002 R3: the model carries the raw status the mark decides from", () => {
    // The row's mark reads the task's own status; the catalogue key alone
    // cannot tell `running` from `waiting_input` once it is a sentence.
    const groups = buildListGroups([task()], { selfDeviceId: "dev-a", t });
    const built = groups[0]!.projects[0]!.rows[0]!;
    expect(built.status).toBe("running");
    expect(built.statusKey).toBe("sessions.statusRunning");
  });

  it("KIN-MOBILE-002 R3: a running row draws a blue dot, a failed row a red square and a done row a grey dot", async () => {
    const screen = await render(<ConversationList {...listProps()} />);

    const running = StyleSheet.flatten(
      markShape(screen, "a1").getByTestId("mark-dot", {
        includeHiddenElements: true,
      }).props.style,
    );
    expect(running.backgroundColor).toBe(palette.light.blue);

    const failed = StyleSheet.flatten(
      markShape(screen, "a2").getByTestId("mark-square", {
        includeHiddenElements: true,
      }).props.style,
    );
    expect(failed.backgroundColor).toBe(palette.light.red);

    const done = StyleSheet.flatten(
      markShape(screen, "a3").getByTestId("mark-dot", {
        includeHiddenElements: true,
      }).props.style,
    );
    expect(done.backgroundColor).toBe(palette.light.muted);
  });

  it("KIN-MOBILE-002 R3: a row with two pending approvals draws an orange triangle and the number 2", async () => {
    const screen = await render(<ConversationList {...listProps()} />);

    const triangle = StyleSheet.flatten(
      markShape(screen, "a4").getByTestId("mark-triangle", {
        includeHiddenElements: true,
      }).props.style,
    );
    // The zero-width border trick paints the triangle through its bottom edge.
    expect(triangle.borderBottomColor).toBe(palette.light.orange);
    expect(triangle.width).toBe(0);
    expect(within(screen.getByTestId("row:a4")).getByText("2")).toBeTruthy();
  });

  it("KIN-MOBILE-002 R3: the spoken name of a row carries its status word, not only its shape", async () => {
    const screen = await render(<ConversationList {...listProps()} />);

    const running = screen.getByTestId("row:a1").props.accessibilityLabel;
    expect(running).toContain("a1 title");
    expect(running).toContain("sessions.statusRunning");

    const pending = screen.getByTestId("row:a4").props.accessibilityLabel;
    expect(pending).toContain("sessions.statusWaitingApproval");
    expect(pending).toContain("sessions.pendingApprovals");

    // The mark itself is decorative: it must not become a second stop.
    const mark = within(screen.getByTestId("row:a1")).getByTestId("row-mark", {
      includeHiddenElements: true,
    });
    expect(mark.props.accessibilityElementsHidden).toBe(true);
    expect(mark.props.importantForAccessibility).toBe("no-hide-descendants");
  });

  it("KIN-MOBILE-002 R3: every row keeps its 54pt minimum and the whole row is the touch target", async () => {
    const onOpen = jest.fn();
    const screen = await render(<ConversationList {...listProps({ onOpen })} />);

    for (const id of ["a1", "a2", "a3", "a4"]) {
      const rowNode = screen.getByTestId(`row:${id}`);
      const style = StyleSheet.flatten(rowNode.props.style);
      expect(style.minHeight).toBeGreaterThanOrEqual(54);
      expect(Math.max(style.height ?? 0, style.minHeight ?? 0)).toBeGreaterThanOrEqual(
        54,
      );
      // The Pressable is the row: no inner control narrows the target.
      expect(rowNode.props.accessibilityRole).toBe("button");
      expect(within(rowNode).queryAllByRole("button")).toHaveLength(0);
    }

    await fireEvent.press(screen.getByTestId("row:a1"));
    expect(onOpen).toHaveBeenCalledWith("a1");
    // The design row is taller than the signed floor but still the 56pt the
    // 820 screenful rule counts.
    expect(ROW_HEIGHT).toBeGreaterThanOrEqual(ROW_MIN_HEIGHT);
  });

  it("KIN-MOBILE-002 R3: hairlines are inset to the text and the last row of a section has none", async () => {
    const screen = await render(<ConversationList {...listProps()} />);

    const hairline = StyleSheet.flatten(
      screen.getByTestId("hairline:a1").props.style,
    );
    expect(hairline.position).toBe("absolute");
    expect(hairline.left).toBe(16);
    expect(hairline.height).toBe(StyleSheet.hairlineWidth);
    expect(hairline.backgroundColor).toBe(palette.light.hairlineStrong);

    // a4 is the last conversation row of the device section (the folded Beta
    // heading follows it), and a section's last row paints no separator.
    expect(screen.queryByTestId("hairline:a4")).toBeNull();
    expect(screen.getByTestId("hairline:a2")).toBeTruthy();
  });

  it("KIN-MOBILE-002 R3: the search field lives in the navigation bar and keeps its clear control", async () => {
    const onQueryChange = jest.fn();
    const screen = await render(
      <ConversationList
        {...listProps({ onQueryChange, query: "alpha" })}
      />,
    );

    const nav = screen.getByTestId("list-nav");
    // The list's title and its one search box share the navigation row; the
    // field is no longer a bar inside the scrolling content.
    expect(within(nav).getByText("nav.sessions")).toBeTruthy();
    const field = within(nav).getByTestId("list-search");
    expect(field.props.value).toBe("alpha");
    expect(field.props.accessibilityLabel).toBe("sessions.searchPlaceholder");
    expect(
      within(screen.getByTestId("list-scroller")).queryByTestId("list-search"),
    ).toBeNull();

    await fireEvent.press(within(nav).getByTestId("list-search-clear"));
    expect(onQueryChange).toHaveBeenCalledWith("");
  });

  it("KIN-MOBILE-002 R3: the device heading and row surfaces paint from the scheme, dark and light", async () => {
    systemScheme.mockReturnValue("dark");
    const dark = await render(<ConversationList {...listProps()} />);
    expect(
      StyleSheet.flatten(dark.getByTestId("device:dev-a").props.style)
        .backgroundColor,
    ).toBe(palette.dark.page);
    expect(
      StyleSheet.flatten(dark.getByTestId("row:a1").props.style)
        .backgroundColor,
    ).toBe(palette.dark.bg);
    expect(
      StyleSheet.flatten(dark.getByText("a1 title").props.style).color,
    ).toBe(palette.dark.text);
    await dark.unmount();

    systemScheme.mockReturnValue("light");
    const light = await render(<ConversationList {...listProps()} />);
    expect(
      StyleSheet.flatten(light.getByTestId("device:dev-a").props.style)
        .backgroundColor,
    ).toBe(palette.light.page);
    expect(
      StyleSheet.flatten(light.getByTestId("row:a1").props.style)
        .backgroundColor,
    ).toBe(palette.light.bg);
  });

  it("KIN-MOBILE-002 R3: the offline banner pushes the rows down instead of covering the first one", async () => {
    const screen = await render(
      <ConversationList
        {...listProps({ resume: { status: "offline", onRetry: () => {} } })}
      />,
    );

    const band = screen.getByTestId("list-resume-band");
    const scroller = screen.getByTestId("list-scroller");
    // The band is in the column above the scroll view, not painted over it:
    // it is neither inside the scroller nor absolutely positioned.
    expect(within(scroller).queryByTestId("list-resume-band")).toBeNull();
    expect(StyleSheet.flatten(band.props.style).position).toBeUndefined();
    const root = screen.getByTestId("list-root");
    expect(root.children.indexOf(band)).toBeLessThan(
      root.children.indexOf(scroller),
    );
    // The first row is still there, below the band in the same column.
    expect(screen.getByTestId("row:a1")).toBeTruthy();
  });

  it("KIN-MOBILE-002 R3: skill and search state survive a re-render with the new row layout", async () => {
    const onToggleProject = jest.fn();
    const screen = await render(
      <ConversationList
        {...listProps({
          initialOffset: 240,
          onToggleProject,
          query: "alpha",
        })}
      />,
    );

    expect(screen.getByText("a1 title")).toBeTruthy();
    expect(screen.getByTestId("list-search").props.value).toBe("alpha");
    expect(screen.getByTestId("list-scroller").props.contentOffset).toEqual({
      x: 0,
      y: 240,
    });

    // Folding Alpha hides its rows while the query, the offset and the heading
    // stay exactly where they were: the new row layout changed no behaviour.
    const folded = state();
    folded.groups[0]!.projects[0]!.open = false;
    await screen.rerender(
      <ConversationList
        {...listProps({
          initialOffset: 240,
          onToggleProject,
          query: "alpha",
          state: folded,
        })}
      />,
    );

    expect(screen.queryByText("a1 title")).toBeNull();
    expect(screen.getByText("▸ Alpha")).toBeTruthy();
    expect(screen.getByTestId("list-search").props.value).toBe("alpha");
    expect(screen.getByTestId("list-scroller").props.contentOffset).toEqual({
      x: 0,
      y: 240,
    });

    // A query disables folding (the heading's fold is invisible during a
    // search), so clearing it must hand the fold back unchanged.
    await screen.rerender(
      <ConversationList
        {...listProps({
          initialOffset: 240,
          onToggleProject,
          query: "",
          state: folded,
        })}
      />,
    );
    await fireEvent.press(screen.getByTestId("project:/work/alpha"));
    expect(onToggleProject).toHaveBeenCalledWith("dev-a", "/work/alpha");
    // The catalogue still carries the rows' words: nothing was invented.
    expect(realT("nav.sessions")).toBeTruthy();
  });
});
