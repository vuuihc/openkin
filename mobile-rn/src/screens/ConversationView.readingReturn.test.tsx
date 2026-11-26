import { describe, expect, it, jest } from "@jest/globals";
import { fireEvent, render } from "@testing-library/react-native";
import { FlatList } from "react-native";
import type { Turn } from "../../../ui/src/components/chat/transcriptProjection";
import type { ThreadState } from "../thread/threadModel";
import { createReadingMemory } from "../thread/readingMemory";
import { t } from "../i18n";
import ConversationView from "./ConversationView";

/**
 * KIN-MOBILE-001 §3/§4 离开再回来 — reopening a conversation lands where the
 * reader was.
 *
 * The signed story promises 「滚动位置与正在读的那条保留；后台回来不跳回顶部」
 * (`docs/product/stories/KIN-MOBILE-001.md:81`) and 「已读位置保留」(`:92`).
 * `#729` keeps the page while the screen stays mounted; this suite is the
 * cross-mount half: Back pops the route, the view (with its refs) unmounts, and
 * the next mount must put the reader back.
 *
 * The harness is `ConversationView.reading.test.tsx`'s: layout is absent under
 * the test renderer, so the cases fire the same scroll and content-size events
 * the platform would, and `scrollToEnd`/`scrollToOffset` are the assertions.
 */

const TASK_ID = "task-reading-place";
const OTHER_ID = "task-elsewhere";
const VIEWPORT_HEIGHT = 800;

type ViewProps = Partial<Parameters<typeof ConversationView>[0]>;
type View = Awaited<ReturnType<typeof render>>;

function state(
  turns: Turn[],
  overrides: Partial<ThreadState> = {},
): ThreadState {
  return {
    taskId: TASK_ID,
    title: "Morning planning",
    status: "ready",
    turns,
    running: false,
    sendQueue: [],
    banner: null,
    reason: null,
    ...overrides,
  };
}

function turn(text: string): Turn {
  return {
    kind: "user",
    item: { kind: "message", key: `user-${text}`, speaker: "you", text },
  };
}

const onBack = jest.fn();

function element(
  turns: Turn[],
  extra: ViewProps = {},
  taskId = TASK_ID,
) {
  return (
    <ConversationView
      onBack={onBack}
      state={state(turns, { taskId })}
      t={t}
      {...extra}
    />
  );
}

async function renderView(
  turns: Turn[],
  extra: ViewProps = {},
  taskId = TASK_ID,
): Promise<View> {
  return render(element(turns, extra, taskId));
}

/** The host FlatList, found by the id the view gives the list itself. */
function list(view: View) {
  return view.getByTestId("conversation:turns");
}

/** The platform event that follows a laid-out content box of `height`. */
async function contentHeight(view: View, height: number): Promise<void> {
  await fireEvent(list(view), "contentSizeChange", 390, height);
}

/** A scroll event at `offset` in content `height` tall. */
async function scrollTo(
  view: View,
  offset: number,
  height: number,
): Promise<void> {
  await fireEvent.scroll(list(view), {
    nativeEvent: {
      contentOffset: { x: 0, y: offset },
      contentSize: { width: 390, height },
      layoutMeasurement: { width: 390, height: VIEWPORT_HEIGHT },
    },
  });
}

describe("KIN-MOBILE-001 §3/§4 reopening a conversation", () => {
  it("KIN-MOBILE-001 §3 离开再回来: reopening lands where the reader was", async () => {
    const scrollToEnd = jest.spyOn(FlatList.prototype, "scrollToEnd");
    const scrollToOffset = jest.spyOn(FlatList.prototype, "scrollToOffset");
    try {
      const memory = createReadingMemory();
      const turns = [turn("one"), turn("two")];

      const first = await renderView(turns, { readingMemory: memory });
      await contentHeight(first, 1600);
      // The reader drags to the top of the thread: far outside the 48pt band.
      await scrollTo(first, 0, 1600);
      // The place is observed on the frame and stored when the route leaves.
      expect(memory.read(TASK_ID)).toBeNull();

      // Back to the list: the whole conversation route goes away.
      await first.unmount();

      // The same conversation opened again lands on the same place.
      const reopened = await renderView(turns, { readingMemory: memory });
      await contentHeight(reopened, 1600);

      expect(scrollToOffset).toHaveBeenCalledWith({
        offset: 0,
        animated: false,
      });
      // The one open-at-the-end was the first mount's; the reopening restored
      // instead of jumping to the newest segment.
      expect(scrollToEnd).toHaveBeenCalledTimes(1);
    } finally {
      scrollToOffset.mockRestore();
      scrollToEnd.mockRestore();
    }
  });

  it("KIN-MOBILE-001 §3 离开再回来: a deep place survives the short first layout", async () => {
    const scrollToEnd = jest.spyOn(FlatList.prototype, "scrollToEnd");
    const scrollToOffset = jest.spyOn(FlatList.prototype, "scrollToOffset");
    try {
      const memory = createReadingMemory();
      const turns = [turn("one"), turn("two")];

      // The reader leaves 3000pt down a 4000pt thread.
      const first = await renderView(turns, { readingMemory: memory });
      await contentHeight(first, 4000);
      await scrollTo(first, 3000, 4000);
      await first.unmount();
      expect(memory.read(TASK_ID)).toEqual({ offset: 3000, pinned: false });

      // The reopening lays out only the list's initial window, so the restore
      // clamps at that short content's own end...
      scrollToEnd.mockClear();
      const reopened = await renderView(turns, { readingMemory: memory });
      await contentHeight(reopened, 1200);
      await scrollTo(reopened, 400, 1200);

      // ...and the rest of the thread lays out. The clamp is not the reader
      // arriving: growth re-issues the move instead of following the end.
      await contentHeight(reopened, 4000);
      expect(scrollToOffset).toHaveBeenCalledTimes(2);
      expect(scrollToOffset).toHaveBeenNthCalledWith(1, {
        offset: 3000,
        animated: false,
      });
      expect(scrollToOffset).toHaveBeenNthCalledWith(2, {
        offset: 3000,
        animated: false,
      });
      expect(scrollToEnd).not.toHaveBeenCalled();

      // The platform delivers the restored offset: the restore is settled, so
      // later growth neither retries it nor jumps to the newest segment.
      await scrollTo(reopened, 3000, 4000);
      await contentHeight(reopened, 4400);
      expect(scrollToOffset).toHaveBeenCalledTimes(2);
      expect(scrollToEnd).not.toHaveBeenCalled();
    } finally {
      scrollToOffset.mockRestore();
      scrollToEnd.mockRestore();
    }
  });

  it("KIN-MOBILE-001 §3 离开再回来: a drag during the restore takes over from it", async () => {
    const scrollToEnd = jest.spyOn(FlatList.prototype, "scrollToEnd");
    const scrollToOffset = jest.spyOn(FlatList.prototype, "scrollToOffset");
    try {
      const memory = createReadingMemory();
      const turns = [turn("one"), turn("two")];

      const first = await renderView(turns, { readingMemory: memory });
      await contentHeight(first, 4000);
      await scrollTo(first, 3000, 4000);
      await first.unmount();

      // The restore is still short of its target when the reader drags: their
      // place wins, and the arriving content must not drag them back.
      scrollToEnd.mockClear();
      const reopened = await renderView(turns, { readingMemory: memory });
      await contentHeight(reopened, 1200);
      await fireEvent(list(reopened), "scrollBeginDrag");
      await scrollTo(reopened, 100, 1200);
      await contentHeight(reopened, 4000);

      expect(scrollToOffset).toHaveBeenCalledTimes(1);
      expect(scrollToEnd).not.toHaveBeenCalled();
    } finally {
      scrollToOffset.mockRestore();
      scrollToEnd.mockRestore();
    }
  });

  it("KIN-MOBILE-001 §3 离开再回来: a reader who left at the live edge still opens at the newest segment", async () => {
    const scrollToEnd = jest.spyOn(FlatList.prototype, "scrollToEnd");
    const scrollToOffset = jest.spyOn(FlatList.prototype, "scrollToOffset");
    try {
      const memory = createReadingMemory();
      const turns = [turn("one"), turn("two")];

      const first = await renderView(turns, { readingMemory: memory });
      await contentHeight(first, 1600);
      // At the live edge: the reader was following the stream when they left.
      await scrollTo(first, 1600, 1600);
      await first.unmount();

      // Content grew while the reader was away, so the place they left is no
      // longer the end: the newest segment is what they came back for.
      const reopened = await renderView(turns, { readingMemory: memory });
      await contentHeight(reopened, 1800);

      expect(scrollToEnd).toHaveBeenCalledTimes(2);
      expect(scrollToEnd).toHaveBeenLastCalledWith({ animated: false });
      expect(scrollToOffset).not.toHaveBeenCalled();
    } finally {
      scrollToOffset.mockRestore();
      scrollToEnd.mockRestore();
    }
  });

  it("KIN-MOBILE-001 §4 离开再回来: a streamed append after a restored place does not yank the page", async () => {
    const scrollToEnd = jest.spyOn(FlatList.prototype, "scrollToEnd");
    try {
      const memory = createReadingMemory();
      const turns = [turn("one"), turn("two")];

      const first = await renderView(turns, { readingMemory: memory });
      await contentHeight(first, 1600);
      await scrollTo(first, 0, 1600);
      await first.unmount();

      const reopened = await renderView(turns, { readingMemory: memory });
      await contentHeight(reopened, 1600);
      expect(scrollToEnd).toHaveBeenCalledTimes(1);

      // A new turn streams in while the reader sits at the restored place. A
      // restored reader is not at the live edge, so growth must leave them be.
      await reopened.rerender(
        element([...turns, turn("three")], { readingMemory: memory }),
      );
      await contentHeight(reopened, 1800);

      expect(scrollToEnd).toHaveBeenCalledTimes(1);
    } finally {
      scrollToEnd.mockRestore();
    }
  });

  it("KIN-MOBILE-001 §3 离开再回来: another conversation never restores the first conversation's place", async () => {
    const scrollToEnd = jest.spyOn(FlatList.prototype, "scrollToEnd");
    const scrollToOffset = jest.spyOn(FlatList.prototype, "scrollToOffset");
    try {
      const memory = createReadingMemory();
      const a = [turn("a one"), turn("a two")];
      const b = [turn("b one"), turn("b two")];

      const first = await renderView(a, { readingMemory: memory });
      await contentHeight(first, 1600);
      await scrollTo(first, 0, 1600);
      await first.unmount();

      // A different conversation reads its own entry, which is empty: it opens
      // on its own newest segment.
      const other = await renderView(b, { readingMemory: memory }, OTHER_ID);
      await contentHeight(other, 1600);
      expect(scrollToEnd).toHaveBeenCalledTimes(2);
      expect(scrollToOffset).not.toHaveBeenCalled();
      await other.unmount();

      // A's place was never moved to B, and A still has it.
      const back = await renderView(a, { readingMemory: memory });
      await contentHeight(back, 1600);
      expect(scrollToOffset).toHaveBeenCalledWith({
        offset: 0,
        animated: false,
      });
      expect(scrollToEnd).toHaveBeenCalledTimes(2);
    } finally {
      scrollToOffset.mockRestore();
      scrollToEnd.mockRestore();
    }
  });

  it("KIN-MOBILE-001 §3 离开再回来: an in-place conversation swap stores the place under the conversation that was read", async () => {
    const memory = createReadingMemory();
    const a = [turn("a one"), turn("a two")];
    const b = [turn("b one"), turn("b two")];

    const view = await renderView(a, { readingMemory: memory });
    await contentHeight(view, 1600);
    await scrollTo(view, 0, 1600);

    // The split route swaps the conversation in place: no unmount, a new id.
    // The place belongs to the conversation it was observed in (AGENTS.md §11).
    await view.rerender(element(b, { readingMemory: memory }, OTHER_ID));
    expect(memory.read(TASK_ID)).toEqual({ offset: 0, pinned: false });
    expect(memory.read(OTHER_ID)).toBeNull();

    // B was never scrolled, so leaving it stores nothing; A keeps its place.
    await view.unmount();
    expect(memory.read(OTHER_ID)).toBeNull();
    expect(memory.read(TASK_ID)).toEqual({ offset: 0, pinned: false });
  });
});
