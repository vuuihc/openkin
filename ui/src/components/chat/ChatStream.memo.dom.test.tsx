// @vitest-environment jsdom
import { render } from "@testing-library/react";
import { describe, expect, it, vi } from "vitest";
import type { TaskEvent } from "../../api/client";

/**
 * What one streaming token is allowed to redraw.
 *
 * A token rebuilds every item in the transcript (the projection is pure over
 * the whole event array), so identity cannot tell a changed message from an
 * unchanged one. The message components compare what they draw instead, and
 * `Markdown` is where that becomes measurable: the stub below counts every
 * body that was rendered, so a redraw of all 300 messages shows up as 300
 * entries rather than as a vague feeling of jank.
 */
const rendered = vi.hoisted(() => ({ texts: [] as string[] }));

vi.mock("../Markdown", () => ({
  default: ({ text }: { text: string }) => {
    rendered.texts.push(text);
    return <div data-markdown="">{text}</div>;
  },
}));

// Imported after the mock so the stub is what ChatStream sees.
import ChatStream, {
  sameMessage,
  sameRow,
  type AssistantMessageItemProps,
  type MessageRowProps,
} from "./ChatStream";

function ev(seq: number, type: string, payload: TaskEvent["payload"]): TaskEvent {
  return { task_id: "task-1", event_epoch: 0, seq, ts: seq, type, payload };
}

const user = ev(1, "message", { role: "user", content: [{ type: "text", text: "why so slow?" }] });
const answerAt = (seq: number, text: string, partial = false): TaskEvent =>
  ev(seq, "message", {
    role: "assistant",
    speaker: "kin",
    ...(partial ? { partial: true } : {}),
    content: [{ type: "text", text }],
  });
const answer = (text: string, partial = false): TaskEvent => answerAt(2, text, partial);

describe("a streaming token", () => {
  it("redraws the message that grew, and nothing else", () => {
    const view = render(
      <ChatStream
        events={[user, answerAt(2, "an earlier answer"), answerAt(4, "because ")]}
        hostSpeaker="kin"
      />,
    );
    // The user bubble draws its text directly; only assistant bodies go through
    // Markdown, which is where the parse cost lives.
    expect(rendered.texts).toEqual(["an earlier answer", "because "]);

    rendered.texts.length = 0;
    view.rerender(
      <ChatStream
        events={[user, answerAt(2, "an earlier answer"), answerAt(4, "because the parser ")]}
        hostSpeaker="kin"
      />,
    );
    expect(rendered.texts).toEqual(["because the parser "]);
  });

  it("redraws nothing when the transcript is the same", () => {
    const view = render(<ChatStream events={[user, answer("done")]} hostSpeaker="kin" />);
    rendered.texts.length = 0;
    // A new array with the same events: what a poll or a task-metadata update
    // hands down between tokens.
    view.rerender(<ChatStream events={[user, answer("done")]} hostSpeaker="kin" />);
    expect(rendered.texts).toEqual([]);
  });

  it("redraws a message whose partial flag settled", () => {
    // The final text can be byte-identical to the last streamed preview; the
    // typing mark and the action row still change, so the flag is part of the
    // comparison.
    const view = render(<ChatStream events={[user, answer("done")]} hostSpeaker="kin" />);
    rendered.texts.length = 0;
    view.rerender(<ChatStream events={[user, answer("done", true)]} hostSpeaker="kin" />);
    expect(rendered.texts).toEqual(["done"]);
  });

  it("keeps the parsed body when only a control flag changes", () => {
    // Busy flips while the body stays byte-identical: the buttons have to
    // disable, the parse must not run again. Two memos stack here — the row
    // and the body — so the assertion covers the pair rather than either one.
    const view = render(
      <ChatStream events={[user, answer("done")]} hostSpeaker="kin" showMessageActions />,
    );
    rendered.texts.length = 0;
    view.rerender(
      <ChatStream
        events={[user, answer("done")]}
        hostSpeaker="kin"
        showMessageActions
        actionsBusy
      />,
    );
    expect(rendered.texts).toEqual([]);
  });
});

/*
 * What the comparators promise, clause by clause.
 *
 * A missing clause is invisible at runtime until the day the prop changes and
 * the screen keeps the old value, so each clause the components read gets a
 * row here. The rows are the props list, not a sample: add a prop to the
 * component and to its comparator, and it needs a row; the type of the table
 * keeps both sides in step.
 */

const messageProps = (
  over: Partial<AssistantMessageItemProps> = {},
): AssistantMessageItemProps => ({
  item: { kind: "message", key: "m1", speaker: "kin", text: "hello", partial: false, seq: 7 },
  messageScope: "task-1",
  showMessageActions: true,
  actionsBusy: false,
  activeFindKey: null,
  selectionMode: false,
  selected: false,
  onToggleSelection: () => undefined,
  onCopyMessage: () => undefined,
  onShareMessage: () => undefined,
  ...over,
});

const MESSAGE_CLAUSES: Array<
  [string, (p: AssistantMessageItemProps) => AssistantMessageItemProps]
> = [
  ["the key", (p) => ({ ...p, item: { ...p.item, key: "m2" } })],
  ["the body", (p) => ({ ...p, item: { ...p.item, text: "hello!" } })],
  ["the partial flag", (p) => ({ ...p, item: { ...p.item, partial: true } })],
  ["the seq", (p) => ({ ...p, item: { ...p.item, seq: 8 } })],
  ["the message scope", (p) => ({ ...p, messageScope: "task-2" })],
  ["the retry/fork gate", (p) => ({ ...p, showMessageActions: false })],
  ["the busy flag", (p) => ({ ...p, actionsBusy: true })],
  ["the find hit", (p) => ({ ...p, activeFindKey: "m1" })],
  ["selection mode", (p) => ({ ...p, selectionMode: true })],
  ["the selection", (p) => ({ ...p, selected: true })],
  ["the save button's presence", (p) => ({ ...p, onSaveArtifact: () => undefined })],
];

describe("sameMessage", () => {
  it.each(MESSAGE_CLAUSES)("redraws when %s changes", (_clause, change) => {
    const base = messageProps();
    expect(sameMessage(base, change(base))).toBe(false);
  });

  it("holds still for a rebuilt item and fresh closures", () => {
    // What the projection and the parent hand down on the next token for a
    // message that did not change: a new item object, new callbacks.
    expect(sameMessage(messageProps(), messageProps())).toBe(true);
  });
});

const rowProps = (over: Partial<MessageRowProps> = {}): MessageRowProps => ({
  messageKey: "u1",
  activeFindKey: null,
  speaker: "user",
  text: "why so slow?",
  partial: false,
  queued: false,
  selectionMode: false,
  selected: false,
  onToggleSelection: () => undefined,
  ...over,
});

const ROW_CLAUSES: Array<[string, (p: MessageRowProps) => MessageRowProps]> = [
  ["the key", (p) => ({ ...p, messageKey: "u2" })],
  ["the find hit", (p) => ({ ...p, activeFindKey: "u1" })],
  ["the speaker", (p) => ({ ...p, speaker: "kin" })],
  ["the body", (p) => ({ ...p, text: "why so slow??" })],
  ["the partial flag", (p) => ({ ...p, partial: true })],
  ["the queued badge", (p) => ({ ...p, queued: true })],
  ["the withdraw control", (p) => ({ ...p, onUnqueue: () => undefined })],
  ["the edit control", (p) => ({ ...p, onEditQueued: () => undefined })],
  ["selection mode", (p) => ({ ...p, selectionMode: true })],
  ["the selection", (p) => ({ ...p, selected: true })],
];

describe("sameRow", () => {
  it.each(ROW_CLAUSES)("redraws when %s changes", (_clause, change) => {
    const base = rowProps();
    expect(sameRow(base, change(base))).toBe(false);
  });

  it("holds still for fresh closures", () => {
    expect(sameRow(rowProps(), rowProps())).toBe(true);
  });
});
