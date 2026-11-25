import { describe, expect, it, jest } from "@jest/globals";
import {
  fireEvent,
  render,
  waitFor,
  within,
} from "@testing-library/react-native";
import { SectionList, StyleSheet } from "react-native";
import ConversationList, {
  BOTTOM_TAB_INSET,
  LIST_HEADER_HEIGHT,
  PRESSED_BG,
  ROW_HEIGHT,
  ROW_MIN_HEIGHT,
  rowsOnScreen,
} from "./ConversationList";
import { t as realT } from "../i18n";
import type {
  ConversationRow,
  DeviceGroup,
  ListViewState,
} from "../list/listModel";

/**
 * KIN-MOBILE-001 R3 — the conversation list screen.
 *
 * The view state is hand-built so the test is about presentation: which rows
 * show under which heading, the 44pt floor, the pending number, and the four
 * non-ready states. Grouping itself is proven in `listModel.test.ts`.
 */

const t = (key: string): string => key;

function row(
  id: string,
  title: string,
  at: number,
  pending = 0,
): ConversationRow {
  return {
    id,
    title,
    agentId: "kin",
    at,
    timeLabel: `t${at}`,
    statusKey: "sessions.statusSucceeded",
    pending,
    remote: false,
  };
}

function state(overrides: Partial<ListViewState> = {}): ListViewState {
  const groups: DeviceGroup[] = [
    {
      id: "dev-a",
      label: "Laptop",
      isSelf: true,
      online: true,
      count: 4,
      projects: [
        {
          key: "/work/alpha",
          label: "Alpha",
          open: true,
          lastActivityAt: 1000,
          rows: [row("a1", "a1 title", 1000, 2), row("a2", "a2 title", 900)],
        },
        {
          key: "/work/beta",
          label: "Beta",
          open: false,
          lastActivityAt: 700,
          rows: [row("b1", "b1 title", 700), row("b2", "b2 title", 600)],
        },
      ],
    },
  ];
  return { status: "ready", groups, error: null, ...overrides };
}

/**
 * The synthetic touch a responder event carries. `Pressable` resolves its
 * `style` function from Pressability's own press-in signal, so a test that
 * wants the held state has to deliver that signal, not call a handler.
 */
function touchEvent() {
  return {
    currentTarget: { measure: () => {} },
    nativeEvent: {
      changedTouches: [],
      identifier: 0,
      locationX: 0,
      locationY: 0,
      pageX: 0,
      pageY: 0,
      target: 0,
      timestamp: Date.now(),
      touches: [],
    },
    persist: () => {},
  };
}

async function renderList(
  overrides: Partial<ListViewState> = {},
  props: Partial<Parameters<typeof ConversationList>[0]> = {},
) {
  return render(
    <ConversationList
      onOpen={() => {}}
      onQueryChange={() => {}}
      onRefresh={() => {}}
      query=""
      state={state(overrides)}
      t={t}
      {...props}
    />,
  );
}

describe("KIN-MOBILE-001 R3 conversation list screen", () => {
  it("KIN-MOBILE-001 R3: draws rows under their project and device headings", async () => {
    const screen = await renderList();
    expect(screen.getByText("Laptop")).toBeTruthy();
    expect(screen.getByText("▾ Alpha")).toBeTruthy();
    expect(screen.getByText("a1 title")).toBeTruthy();
    expect(screen.getByText("a2 title")).toBeTruthy();
  });

  it("KIN-MOBILE-001 R3: a folded project keeps its heading and hides its rows", async () => {
    const screen = await renderList();
    expect(screen.getByText("▸ Beta")).toBeTruthy();
    expect(screen.queryByText("b1 title")).toBeNull();
    expect(screen.queryByText("b2 title")).toBeNull();
  });

  it("KIN-MOBILE-001 R3: every row is at least a 44pt target", async () => {
    const screen = await renderList();
    for (const id of ["a1", "a2"]) {
      const style = StyleSheet.flatten(
        screen.getByTestId(`row:${id}`).props.style,
      );
      const height = style.height ?? 0;
      const minHeight = style.minHeight ?? 0;
      expect(Math.max(height, minHeight)).toBeGreaterThanOrEqual(44);
    }
  });

  it("KIN-MOBILE-001 R3: a row with two pending items shows 2 with a spoken label", async () => {
    const screen = await renderList();
    const badge = screen.getByText("2");
    expect(badge).toBeTruthy();
    // The number is not the only channel: the catalogue sentence is the
    // accessibility label (TASTE 11/18 — never state by colour or glyph alone).
    expect(screen.getByLabelText("sessions.pendingApprovals")).toBeTruthy();
    // The row button is one accessible element, so the sentence must also be
    // on the row itself — a child badge's label is not read while it has focus.
    expect(screen.getByTestId("row:a1").props.accessibilityLabel).toBe(
      "a1 title · kin · t1000 · sessions.statusSucceeded · sessions.pendingApprovals",
    );
    expect(screen.getByTestId("row:a2").props.accessibilityLabel).toBe(
      "a2 title · kin · t900 · sessions.statusSucceeded",
    );
  });

  it("KIN-MOBILE-001 R3: a failed refresh still shows the rows already loaded", async () => {
    const screen = await renderList({ status: "failed", error: "unreachable" });
    expect(screen.getByText("a1 title")).toBeTruthy();
    expect(screen.getByText("pairing.unreachable")).toBeTruthy();
    expect(screen.getByText("pairing.retry")).toBeTruthy();
  });

  it("KIN-MOBILE-001 R3: an offline read keeps the rows and says why", async () => {
    const screen = await renderList({ status: "offline", error: "unreachable" });
    expect(screen.getByText("a1 title")).toBeTruthy();
    expect(screen.getByText("pairing.unreachable")).toBeTruthy();
  });

  it("KIN-MOBILE-001 R3: tapping a row opens that task", async () => {
    const onOpen = jest.fn();
    const screen = await renderList({}, { onOpen });
    await fireEvent.press(screen.getByTestId("row:a1"));
    expect(onOpen).toHaveBeenCalledWith("a1");
  });

  it("KIN-MOBILE-001 R3: tapping a project reports its fold toggle", async () => {
    const onToggleProject = jest.fn();
    const screen = await renderList({}, { onToggleProject });
    await fireEvent.press(screen.getByTestId("project:/work/beta"));
    expect(onToggleProject).toHaveBeenCalledWith("dev-a", "/work/beta");
  });

  it("KIN-MOBILE-001 §2: pressing a conversation row paints a pressed state", async () => {
    const screen = await renderList();
    const resting = StyleSheet.flatten(
      screen.getByTestId("row:a1").props.style,
    );
    expect(resting.backgroundColor).not.toBe(PRESSED_BG);

    // A finger lands: Pressability's grant/activation turns the row's style
    // function into the held array before any navigation can happen.
    await fireEvent(
      screen.getByTestId("row:a1"),
      "responderGrant",
      touchEvent(),
    );
    expect(
      StyleSheet.flatten(screen.getByTestId("row:a1").props.style)
        .backgroundColor,
    ).toBe(PRESSED_BG);

    // Lifting the finger returns the row to its resting paint. Pressable holds
    // the pressed state for its minimum press duration, so the release is a
    // transition to wait for, not a synchronous repaint.
    await fireEvent(
      screen.getByTestId("row:a1"),
      "responderRelease",
      touchEvent(),
    );
    await waitFor(() =>
      expect(
        StyleSheet.flatten(screen.getByTestId("row:a1").props.style)
          .backgroundColor,
      ).toBe(resting.backgroundColor),
    );
    expect(
      StyleSheet.flatten(screen.getByTestId("row:a1").props.style)
        .backgroundColor,
    ).not.toBe(PRESSED_BG);
  });

  it("KIN-MOBILE-001 §2: pressing a project heading paints a pressed state", async () => {
    const screen = await renderList();
    const resting = StyleSheet.flatten(
      screen.getByTestId("project:/work/alpha").props.style,
    );
    expect(resting.backgroundColor).not.toBe(PRESSED_BG);

    await fireEvent(
      screen.getByTestId("project:/work/alpha"),
      "responderGrant",
      touchEvent(),
    );
    expect(
      StyleSheet.flatten(screen.getByTestId("project:/work/alpha").props.style)
        .backgroundColor,
    ).toBe(PRESSED_BG);

    await fireEvent(
      screen.getByTestId("project:/work/alpha"),
      "responderRelease",
      touchEvent(),
    );
    await waitFor(() =>
      expect(
        StyleSheet.flatten(
          screen.getByTestId("project:/work/alpha").props.style,
        ).backgroundColor,
      ).toBe(resting.backgroundColor),
    );
  });

  it("KIN-MOBILE-001 §2: the first load draws the list's shape, not a lone wheel", async () => {
    const screen = await renderList({ status: "loading", groups: [] });

    const skeleton = screen.getByTestId("list-skeleton");
    // The loading sentence is spoken once by the shape's container; the bars
    // themselves carry no words (the old lone sentence is no longer drawn).
    expect(skeleton.props.accessibilityLabel).toBe("sessions.loading");
    expect(screen.getByTestId("list-skeleton-heading")).toBeTruthy();
    expect(screen.getAllByTestId("list-skeleton-row")).toHaveLength(3);
    expect(screen.queryByText("sessions.loading")).toBeNull();
  });

  it("KIN-MOBILE-001 §2: a refresh with rows keeps them and draws no skeleton", async () => {
    // A cached page being refreshed is a page, not a first load: the rows stay
    // and no skeleton takes their place (TASTE 15).
    const screen = await renderList({ status: "loading" });
    expect(screen.getByText("a1 title")).toBeTruthy();
    expect(screen.getByTestId("row:a1")).toBeTruthy();
    expect(screen.queryByTestId("list-skeleton")).toBeNull();
  });

  it("KIN-MOBILE-001 §2: the skeleton is not a row", async () => {
    const onOpen = jest.fn();
    const screen = await renderList(
      { status: "loading", groups: [] },
      { onOpen },
    );
    const skeleton = screen.getByTestId("list-skeleton");

    // Each real row is one accessible stop; a decorative bar is none.
    expect(within(skeleton).queryAllByTestId(/^row:/)).toHaveLength(0);
    expect(
      skeleton.queryAll((node) => node.props.accessibilityRole === "button"),
    ).toHaveLength(0);

    for (const bar of screen.getAllByTestId("list-skeleton-row")) {
      expect(bar.props.accessibilityRole).toBeUndefined();
      await fireEvent.press(bar);
    }
    expect(onOpen).not.toHaveBeenCalled();
  });

  it("KIN-MOBILE-001 R3: loading, empty, failed and expired each say something", async () => {
    const loading = await renderList({ status: "loading", groups: [] });
    expect(loading.getByTestId("list-skeleton")).toBeTruthy();

    const empty = await renderList({ status: "empty", groups: [] });
    expect(empty.getByText("sessions.empty")).toBeTruthy();
    expect(empty.getByText("sessions.emptyHint")).toBeTruthy();

    const expired = await renderList({
      status: "failed",
      groups: [],
      error: "expired",
    });
    expect(expired.getByText("sessions.loadError")).toBeTruthy();
    expect(expired.getByText("pairing.expired")).toBeTruthy();
    expect(expired.getByText("pairing.retry")).toBeTruthy();
  });

  it("KIN-MOBILE-001 R3: an empty-device group does not hide the empty or offline state", async () => {
    // `listModel` builds with `includeEmptyDevices: true`, so a paired machine
    // with nothing in it still yields a group with `count: 0`. A section list
    // with any section never draws `ListEmptyComponent`; the words must win.
    const groups: DeviceGroup[] = [
      {
        id: "dev-empty",
        label: "Empty machine",
        isSelf: false,
        online: true,
        count: 0,
        projects: [],
      },
    ];
    const empty = await renderList({ status: "empty", groups });
    expect(empty.getByText("sessions.empty")).toBeTruthy();
    expect(empty.getByText("sessions.emptyHint")).toBeTruthy();
    expect(empty.queryByText("Empty machine")).toBeNull();

    const offline = await renderList({
      status: "offline",
      groups,
      error: "unreachable",
    });
    expect(offline.getByText("sessions.loadError")).toBeTruthy();
    expect(offline.getByText("pairing.unreachable")).toBeTruthy();
    expect(offline.getByText("pairing.retry")).toBeTruthy();
    expect(offline.queryByText("Empty machine")).toBeNull();
  });

  it("KIN-MOBILE-001 R7: the band speaks app.reconnecting while resuming and has no control", async () => {
    const screen = await renderList(
      {},
      { resume: { status: "resuming", onRetry: () => {} } },
    );

    const band = screen.getByText("app.reconnecting");
    // A polite live region: the reader hears the reconnect once, without
    // being interrupted mid-row.
    expect(band.props.accessibilityLiveRegion).toBe("polite");
    // Nothing to press while the refresh is still in flight.
    expect(screen.queryByText("pairing.retry")).toBeNull();
    expect(screen.queryByTestId("list-resume-retry")).toBeNull();
    expect(screen.queryByText("pairing.unreachable")).toBeNull();
  });

  it("KIN-MOBILE-001 R7: the offline band's retry meets the 44pt floor and calls back once", async () => {
    const onRetry = jest.fn();
    const screen = await renderList(
      // A failed read is already drawing its own reason line; the resume band
      // must still be one band, not a second stacked banner.
      { status: "failed", error: "unreachable" },
      { resume: { status: "offline", onRetry } },
    );

    expect(screen.getAllByText("pairing.unreachable")).toHaveLength(1);
    // The failure is announced, not only drawn (RN's live region is Android-only).
    expect(screen.getByText("pairing.unreachable").props.accessibilityRole).toBe(
      "alert",
    );
    const retry = screen.getByTestId("list-resume-retry");
    expect(retry.props.accessibilityRole).toBe("button");
    const style = StyleSheet.flatten(retry.props.style);
    expect(style.minHeight).toBeGreaterThanOrEqual(44);
    expect(style.minWidth).toBeGreaterThanOrEqual(44);

    await fireEvent.press(retry);
    expect(onRetry).toHaveBeenCalledTimes(1);
  });

  it("KIN-MOBILE-001 R7: without cached rows the band is the only reason and the only retry", async () => {
    const onRetry = jest.fn();
    const offline = await renderList(
      { status: "offline", groups: [], error: "unreachable" },
      { resume: { status: "offline", onRetry } },
    );

    // Empty view + band would otherwise print the same sentence and offer two
    // different retries (one direct read, one resume series).
    expect(offline.getAllByText("pairing.unreachable")).toHaveLength(1);
    expect(offline.getAllByText("pairing.retry")).toHaveLength(1);
    expect(offline.getByTestId("list-resume-retry")).toBeTruthy();
    expect(offline.getByText("sessions.loadError")).toBeTruthy();

    const resuming = await renderList(
      { status: "offline", groups: [], error: "unreachable" },
      { resume: { status: "resuming", onRetry } },
    );
    // No cache while the series is still running is a loading screen, not an
    // error screen with a control the reader should not press yet.
    expect(resuming.getByText("sessions.loading")).toBeTruthy();
    expect(resuming.queryByText("sessions.loadError")).toBeNull();
    expect(resuming.queryByText("pairing.retry")).toBeNull();

    // The band's sentence is the generic network one; a refused link keeps its
    // own signed words even with no rows cached.
    const rejected = await renderList(
      { status: "failed", groups: [], error: "rejected" },
      { resume: { status: "offline", onRetry } },
    );
    expect(rejected.getByText("pairing.rejected")).toBeTruthy();
  });

  it("KIN-MOBILE-001 R3: fits ten full rows in an 820×1180 screenful", () => {
    expect(ROW_MIN_HEIGHT).toBeGreaterThanOrEqual(44);
    expect(ROW_HEIGHT).toBeGreaterThanOrEqual(ROW_MIN_HEIGHT);
    expect(rowsOnScreen(1180)).toBe(
      Math.floor((1180 - LIST_HEADER_HEIGHT - BOTTOM_TAB_INSET) / ROW_HEIGHT),
    );
    expect(rowsOnScreen(1180)).toBeGreaterThanOrEqual(10);
  });

  it("KIN-MOBILE-001 R3: the search field speaks the catalogue placeholder and reports what is typed", async () => {
    const onQueryChange = jest.fn();
    const screen = await renderList({}, { onQueryChange });
    const field = screen.getByTestId("list-search");

    // One catalogue word for the hint and the spoken name: a second string
    // would be a second chance to say something else.
    expect(field.props.accessibilityLabel).toBe("sessions.searchPlaceholder");
    expect(field.props.placeholder).toBe("sessions.searchPlaceholder");

    await fireEvent.changeText(field, "alpha");
    expect(onQueryChange).toHaveBeenCalledWith("alpha");
  });

  it("KIN-MOBILE-001 R3: the search field and its clear button are each a 44pt target", async () => {
    const screen = await renderList({}, { query: "alpha" });
    const field = StyleSheet.flatten(
      screen.getByTestId("list-search").props.style,
    );
    expect(Math.max(field.height ?? 0, field.minHeight ?? 0)).toBeGreaterThanOrEqual(44);

    const clear = StyleSheet.flatten(
      screen.getByTestId("list-search-clear").props.style,
    );
    expect(Math.max(clear.height ?? 0, clear.minHeight ?? 0)).toBeGreaterThanOrEqual(44);
    expect(Math.max(clear.width ?? 0, clear.minWidth ?? 0)).toBeGreaterThanOrEqual(44);
  });

  it("KIN-MOBILE-001 R3: the clear button empties the query", async () => {
    const onQueryChange = jest.fn();
    const screen = await renderList({}, { query: "alpha", onQueryChange });
    await fireEvent.press(screen.getByTestId("list-search-clear"));
    expect(onQueryChange).toHaveBeenCalledWith("");
  });

  it("KIN-MOBILE-001 R3: a query with no match says so with the query substituted", async () => {
    const screen = await renderList(
      { status: "ready", groups: [] },
      { query: "  zzz  ", t: realT },
    );
    // The shared catalogue carries the sentence on both locales; the screen
    // passes the trimmed query as the parameter, never a second copy.
    expect(
      screen.getByText(realT("sessions.searchEmpty", { query: "zzz" })),
    ).toBeTruthy();
    expect(screen.queryByText(realT("sessions.empty"))).toBeNull();
  });

});

describe("KIN-MOBILE-001 R3 list place", () => {
  it("KIN-MOBILE-001 R3: the list starts at the offset the memory restored", async () => {
    const scrollTo = jest.fn();
    const spy = jest
      .spyOn(SectionList.prototype, "getScrollResponder")
      .mockReturnValue({
        scrollTo,
      } as unknown as ReturnType<
        SectionList<never, never>["getScrollResponder"]
      >);
    try {
      const screen = await renderList({}, { initialOffset: 240 });
      const scroller = screen.getByTestId("list-scroller");

      // iOS places the list at the restored offset before content lays out;
      // the cross-platform restore lands once, after it does.
      expect(scroller.props.contentOffset).toEqual({ x: 0, y: 240 });
      await fireEvent(scroller, "contentSizeChange", 390, 4000);
      await fireEvent(scroller, "contentSizeChange", 390, 4200);
      expect(scrollTo).toHaveBeenCalledTimes(1);
      expect(scrollTo).toHaveBeenCalledWith({ x: 0, y: 240, animated: false });
    } finally {
      spy.mockRestore();
    }
  });

  it("KIN-MOBILE-001 R3: every scroll reports its offset back to the container", async () => {
    const onScrollOffset = jest.fn();
    const screen = await renderList({}, { initialOffset: 240, onScrollOffset });
    const scroller = screen.getByTestId("list-scroller");

    await fireEvent.scroll(scroller, {
      nativeEvent: {
        contentOffset: { x: 0, y: 180 },
        contentSize: { width: 390, height: 4000 },
        layoutMeasurement: { width: 390, height: 800 },
      },
    });
    expect(onScrollOffset).toHaveBeenCalledWith(180);

    // A fresh scroll reports its own place, not the restored one.
    await fireEvent.scroll(scroller, {
      nativeEvent: {
        contentOffset: { x: 0, y: 420 },
        contentSize: { width: 390, height: 4000 },
        layoutMeasurement: { width: 390, height: 800 },
      },
    });
    expect(onScrollOffset).toHaveBeenLastCalledWith(420);
  });
});
