import { describe, expect, it, jest } from "@jest/globals";
import { fireEvent, render } from "@testing-library/react-native";
import { StyleSheet } from "react-native";
import ConversationList, {
  BOTTOM_TAB_INSET,
  LIST_HEADER_HEIGHT,
  ROW_HEIGHT,
  ROW_MIN_HEIGHT,
  rowsOnScreen,
} from "./ConversationList";
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

function renderList(
  overrides: Partial<ListViewState> = {},
  props: Partial<Parameters<typeof ConversationList>[0]> = {},
) {
  return render(
    <ConversationList
      onOpen={() => {}}
      onRefresh={() => {}}
      state={state(overrides)}
      t={t}
      {...props}
    />,
  );
}

describe("KIN-MOBILE-001 R3 conversation list screen", () => {
  it("KIN-MOBILE-001 R3: draws rows under their project and device headings", () => {
    const screen = renderList();
    expect(screen.getByText("Laptop")).toBeTruthy();
    expect(screen.getByText("Alpha")).toBeTruthy();
    expect(screen.getByText("a1 title")).toBeTruthy();
    expect(screen.getByText("a2 title")).toBeTruthy();
  });

  it("KIN-MOBILE-001 R3: a folded project keeps its heading and hides its rows", () => {
    const screen = renderList();
    expect(screen.getByText("Beta")).toBeTruthy();
    expect(screen.queryByText("b1 title")).toBeNull();
    expect(screen.queryByText("b2 title")).toBeNull();
  });

  it("KIN-MOBILE-001 R3: every row is at least a 44pt target", () => {
    const screen = renderList();
    for (const id of ["a1", "a2"]) {
      const style = StyleSheet.flatten(screen.getByTestId(`row:${id}`).props.style);
      const height = style.height ?? 0;
      const minHeight = style.minHeight ?? 0;
      expect(Math.max(height, minHeight)).toBeGreaterThanOrEqual(44);
    }
  });

  it("KIN-MOBILE-001 R3: a row with two pending items shows 2", () => {
    const screen = renderList();
    expect(screen.getByText("2")).toBeTruthy();
  });

  it("KIN-MOBILE-001 R3: a failed refresh still shows the rows already loaded", () => {
    const screen = renderList({ status: "failed", error: "unreachable" });
    expect(screen.getByText("a1 title")).toBeTruthy();
    expect(screen.getByText("pairing.unreachable")).toBeTruthy();
  });

  it("KIN-MOBILE-001 R3: tapping a row opens that task", () => {
    const onOpen = jest.fn();
    const screen = renderList({}, { onOpen });
    fireEvent.press(screen.getByTestId("row:a1"));
    expect(onOpen).toHaveBeenCalledWith("a1");
  });

  it("KIN-MOBILE-001 R3: tapping a project reports its fold toggle", () => {
    const onToggleProject = jest.fn();
    const screen = renderList({}, { onToggleProject });
    fireEvent.press(screen.getByTestId("project:/work/beta"));
    expect(onToggleProject).toHaveBeenCalledWith("dev-a", "/work/beta");
  });

  it("KIN-MOBILE-001 R3: loading, empty, failed and offline each say something", () => {
    const loading = renderList({ status: "loading", groups: [] });
    expect(loading.getByText("sessions.loading")).toBeTruthy();

    const empty = renderList({ status: "empty", groups: [] });
    expect(empty.getByText("sessions.empty")).toBeTruthy();
    expect(empty.getByText("sessions.emptyHint")).toBeTruthy();

    const expired = renderList({
      status: "failed",
      groups: [],
      error: "expired",
    });
    expect(expired.getByText("sessions.loadError")).toBeTruthy();
    expect(expired.getByText("pairing.expired")).toBeTruthy();
    expect(expired.getByText("pairing.retry")).toBeTruthy();

    const offline = renderList({ status: "offline", error: "unreachable" });
    expect(offline.getByText("a1 title")).toBeTruthy();
    expect(offline.getByText("pairing.unreachable")).toBeTruthy();
  });

  it("KIN-MOBILE-001 R3: fits ten full rows in an 820×1180 screenful", () => {
    expect(ROW_MIN_HEIGHT).toBeGreaterThanOrEqual(44);
    expect(ROW_HEIGHT).toBeGreaterThanOrEqual(ROW_MIN_HEIGHT);
    expect(rowsOnScreen(1180)).toBe(
      Math.floor((1180 - LIST_HEADER_HEIGHT - BOTTOM_TAB_INSET) / ROW_HEIGHT),
    );
    expect(rowsOnScreen(1180)).toBeGreaterThanOrEqual(10);
  });
});
