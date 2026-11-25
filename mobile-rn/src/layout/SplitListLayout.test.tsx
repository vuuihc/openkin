import { afterEach, beforeEach, describe, expect, it, jest } from "@jest/globals";
import { act, fireEvent, render } from "@testing-library/react-native";
import { useEffect, useState } from "react";
import { Pressable, StyleSheet, Text, View } from "react-native";
import SplitListLayout from "./SplitListLayout";

/**
 * KIN-MOBILE-001 R3 — the list's split presentation.
 *
 * The boundary itself is proven in `split.test.ts`; this suite is about what
 * the reader sees: 767 is still the phone stack, 768 is a 304pt list beside
 * the conversation, a tap in the list opens that conversation while the list
 * stays, and a selection change never lets the previous conversation's late
 * answer paint under the new one (AGENTS.md §11).
 */

const EMPTY_LABEL = "Pick a chat to read it here";

function ListProbe({ onOpen }: { onOpen: (taskId: string) => void }) {
  return (
    <View testID="list-probe">
      <Pressable onPress={() => onOpen("task-a")} testID="row-a">
        <Text>task-a</Text>
      </Pressable>
      <Pressable onPress={() => onOpen("task-b")} testID="row-b">
        <Text>task-b</Text>
      </Pressable>
    </View>
  );
}

/**
 * A conversation whose read starts once, at mount, and answers with the id it
 * mounted with — the shape of a request that outlives a selection change. Only
 * remounting on the new id keeps that answer off the new title.
 */
function LateAnswer({ taskId }: { taskId: string }) {
  const [answer, setAnswer] = useState("pending");
  useEffect(() => {
    const timer = setTimeout(() => setAnswer(`answer:${taskId}`), 50);
    return () => clearTimeout(timer);
    // Mount-only on purpose: this stands in for a read already in flight.
  }, []);
  return <Text testID="conversation">{answer}</Text>;
}

function Harness({ width }: { width: number }) {
  const [selected, setSelected] = useState<string | null>(null);
  return (
    <SplitListLayout
      conversation={selected === null ? null : <LateAnswer taskId={selected} />}
      emptyLabel={EMPTY_LABEL}
      list={<ListProbe onOpen={setSelected} />}
      selectedTaskId={selected}
      width={width}
    />
  );
}

describe("KIN-MOBILE-001: the list's split presentation", () => {
  beforeEach(() => {
    jest.useFakeTimers();
  });

  afterEach(() => {
    jest.useRealTimers();
  });

  it("KIN-MOBILE-001: a 767pt window stays the phone stack", async () => {
    const screen = await render(<Harness width={767} />);
    expect(screen.getByTestId("list-stack-column")).toBeTruthy();
    expect(screen.queryByTestId("list-split-column")).toBeNull();
    expect(screen.queryByTestId("list-split-conversation")).toBeNull();

    // A tap still reaches the route; this layout draws no conversation.
    await fireEvent.press(screen.getByTestId("row-a"));
    expect(screen.queryByTestId("conversation")).toBeNull();
  });

  it("KIN-MOBILE-001: a 768pt window puts the list in a 304pt column beside the conversation", async () => {
    const screen = await render(<Harness width={768} />);
    expect(screen.getByTestId("list-split-conversation")).toBeTruthy();
    const column = screen.getByTestId("list-split-column");
    const style = StyleSheet.flatten(column.props.style);
    expect(style.width).toBe(304);
    // `flex: 1` sets flexBasis 0 on a row's main axis and would override that
    // width; the signed column must opt out of both grow and shrink.
    expect(style.flexGrow).toBe(0);
    expect(style.flexShrink).toBe(0);
  });

  it("KIN-MOBILE-001: at 820 tapping a row shows that conversation while the list stays rendered", async () => {
    const screen = await render(<Harness width={820} />);
    expect(screen.getByText(EMPTY_LABEL)).toBeTruthy();

    await fireEvent.press(screen.getByTestId("row-a"));

    expect(screen.getByTestId("list-probe")).toBeTruthy();
    expect(screen.getByTestId("list-split-column")).toBeTruthy();
    expect(screen.getByTestId("conversation").props.children).toBe("pending");
    expect(screen.queryByText(EMPTY_LABEL)).toBeNull();
  });

  it("KIN-MOBILE-001: an empty selection names the choice instead of showing a blank pane", async () => {
    const screen = await render(<Harness width={820} />);
    expect(screen.getByText(EMPTY_LABEL)).toBeTruthy();
    expect(screen.queryByTestId("conversation")).toBeNull();
  });

  it("KIN-MOBILE-001: a new selection drops the previous conversation's late answer", async () => {
    const screen = await render(<Harness width={820} />);

    await fireEvent.press(screen.getByTestId("row-a"));
    // The first read has not answered yet when the reader picks another row.
    await fireEvent.press(screen.getByTestId("row-b"));
    await act(() => {
      jest.advanceTimersByTime(100);
    });

    expect(screen.getByTestId("conversation").props.children).toBe(
      "answer:task-b",
    );
    expect(screen.queryByText("answer:task-a")).toBeNull();
  });

  it("KIN-MOBILE-001: the split dispatches no request of its own", async () => {
    const fetchSpy = jest.fn();
    const original = globalThis.fetch;
    globalThis.fetch = fetchSpy as unknown as typeof fetch;
    try {
      const screen = await render(<Harness width={820} />);
      await fireEvent.press(screen.getByTestId("row-a"));
      await act(() => {
        jest.advanceTimersByTime(100);
      });
      // Each pane owns its own bounded read; laying them out asks for nothing.
      expect(fetchSpy).not.toHaveBeenCalled();
    } finally {
      globalThis.fetch = original;
    }
  });
});
