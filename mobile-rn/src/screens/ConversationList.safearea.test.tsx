import { describe, expect, it } from "@jest/globals";
import { render } from "@testing-library/react-native";
import { StyleSheet } from "react-native";
import { SafeAreaProvider } from "react-native-safe-area-context";
import type { ReactNode } from "react";
import SplitListLayout from "../layout/SplitListLayout";
import { headerTopInset } from "../native/insets";
import type { ListViewState } from "../list/listModel";
import ConversationList, { ROW_HEIGHT } from "./ConversationList";

/**
 * KIN-MOBILE-001 R3 — the list's header sits below the status bar.
 *
 * On a notched iPhone the status bar's clock and battery painted over the
 * list's large title, because the list header never read the device's top
 * inset (EVIDENCE.md §已知 D5). The conversation header already threads the
 * same inset (`ConversationView.tsx:1077`); this suite pins the list to the
 * same arithmetic, at 390 in the phone stack and at 820 in the split's left
 * column.
 *
 * The provider is per-test, as in `Conversation.safearea.test.tsx`: the rest
 * of the phone suite renders without insets and must stay unaffected. The
 * zero-inset and no-provider cases are the controls — a blanket padding would
 * add air to a device that reports none, and the fallback must not throw.
 */

const t = (key: string): string => key;

function state(overrides: Partial<ListViewState> = {}): ListViewState {
  return {
    status: "ready",
    error: null,
    groups: [
      {
        id: "dev-a",
        label: "Laptop",
        isSelf: true,
        online: true,
        count: 1,
        projects: [
          {
            key: "/work/alpha",
            label: "Alpha",
            open: true,
            lastActivityAt: 1000,
            rows: [
              {
                id: "a1",
                title: "a1 title",
                agentId: "kin",
                at: 1000,
                timeLabel: "t1000",
                statusKey: "sessions.statusSucceeded",
                status: "succeeded",
                pending: 0,
                remote: false,
              },
            ],
          },
        ],
      },
    ],
    ...overrides,
  };
}

function list(overrides: Partial<ListViewState> = {}) {
  return (
    <ConversationList
      onOpen={() => {}}
      onQueryChange={() => {}}
      onRefresh={() => {}}
      query=""
      state={state(overrides)}
      t={t}
    />
  );
}

/** The view under a provider carrying a notched iPhone's top inset. */
function withTopInset(top: number, children: ReactNode) {
  return (
    <SafeAreaProvider
      initialMetrics={{
        frame: { x: 0, y: 0, width: 390, height: 844 },
        insets: { top, left: 0, right: 0, bottom: 34 },
      }}
    >
      {children}
    </SafeAreaProvider>
  );
}

type Rendered = Awaited<ReturnType<typeof render>>;

function navPaddingTop(screen: Rendered): number | undefined {
  const style = StyleSheet.flatten(screen.getByTestId("list-nav").props.style);
  return style.paddingTop;
}

describe("KIN-MOBILE-001 R3: the list clears the status bar", () => {
  it("KIN-MOBILE-001 R3: the list header sits below the status bar", async () => {
    const screen = await render(withTopInset(59, list()));

    // The same number the conversation header resolves to on this device.
    expect(headerTopInset(59)).toBe(67);
    expect(navPaddingTop(screen)).toBe(67);
  });

  it("KIN-MOBILE-001 R3: a device without an inset keeps the compact header", async () => {
    const screen = await render(withTopInset(0, list()));

    // The control: a blanket padding would add notch-sized air to a phone
    // that reports none.
    expect(navPaddingTop(screen)).toBe(12);
  });

  it("KIN-MOBILE-001 R3: a missing provider is a device that reports no inset", async () => {
    const screen = await render(list());

    // The rest of the phone suite renders the list without a provider; the
    // fallback must read zero rather than throw.
    expect(navPaddingTop(screen)).toBe(12);
  });

  it("KIN-MOBILE-001 R3: the first row starts below the inset header", async () => {
    const screen = await render(withTopInset(59, list()));
    const root = screen.getByTestId("list-root");

    // Paint order, not colour: the bar is the first thing in the column and
    // the scroller follows it, so no row can be laid out under the clock.
    const direct = root.children;
    const testIdOf = (child: (typeof direct)[number]) =>
      typeof child === "string" ? undefined : child.props.testID;
    const navAt = direct.findIndex((child) => testIdOf(child) === "list-nav");
    const scrollerAt = direct.findIndex(
      (child) => testIdOf(child) === "list-scroller",
    );
    expect(navAt).toBeGreaterThanOrEqual(0);
    expect(scrollerAt).toBeGreaterThan(navAt);

    // In normal flow: nothing lifts the scroller back under the header.
    const scroller = StyleSheet.flatten(
      screen.getByTestId("list-scroller").props.style,
    );
    expect(scroller.position).not.toBe("absolute");
    expect(scroller.marginTop ?? 0).toBe(0);

    // The header's own box starts at the inset and is at least a full row.
    const nav = StyleSheet.flatten(screen.getByTestId("list-nav").props.style);
    expect((nav.paddingTop ?? 0) + (nav.minHeight ?? 0)).toBe(
      headerTopInset(59) + ROW_HEIGHT,
    );
  });

  it("KIN-MOBILE-001 R3: the cold-start skeleton keeps the header below the status bar", async () => {
    const screen = await render(
      withTopInset(59, list({ status: "loading", groups: [] })),
    );

    // The first frame is the same nav bar as the loaded page, so the header
    // does not move when the rows arrive.
    expect(navPaddingTop(screen)).toBe(67);
  });

  it("KIN-MOBILE-001 R3: the 820 split column uses the same inset", async () => {
    const screen = await render(
      withTopInset(
        59,
        <SplitListLayout
          conversation={null}
          emptyLabel="pick a conversation"
          list={list()}
          selectedTaskId={null}
          width={820}
        />,
      ),
    );

    // The list owns the inset, so the split must not add a second one.
    expect(navPaddingTop(screen)).toBe(67);
    const split = StyleSheet.flatten(
      screen.getByTestId("list-layout").props.style,
    );
    expect(split.paddingTop ?? 0).toBe(0);
  });
});
