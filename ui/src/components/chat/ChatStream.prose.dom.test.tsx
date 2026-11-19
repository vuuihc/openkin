// @vitest-environment jsdom
import { beforeEach, describe, expect, it, vi } from "vitest";
import { fireEvent, render, screen } from "@testing-library/react";
import type { ComponentProps } from "react";
import type { TaskEvent } from "../../api/client";
import { t } from "../../i18n";
import ChatStream from "./ChatStream";

function event(seq: number, type: string, payload: TaskEvent["payload"]): TaskEvent {
  return { task_id: "task-prose", event_epoch: 0, seq, ts: seq, type, payload };
}

const userMessage = (seq: number, text: string) =>
  event(seq, "message", { role: "user", content: [{ type: "text", text }] });

const note = (seq: number, role: string, text: string) =>
  event(seq, "message", {
    role,
    phase: "progress",
    speaker: "kin",
    content: [{ type: "text", text }],
    partial: false,
    visibility: { user: true, task: true },
  });

const toolCall = (seq: number, id: string) =>
  event(seq, "tool_use", {
    speaker: "kin",
    tool_use_id: id,
    name: "bash",
    input: { command: "ls" },
    visibility: { user: true, task: true },
  });

const toolResult = (seq: number, id: string) =>
  event(seq, "tool_result", {
    speaker: "kin",
    tool_use_id: id,
    name: "bash",
    output: "a.ts b.ts",
    ok: true,
    visibility: { user: true, task: true },
  });

// Reasoning, a tool call, then narration: the shape of a running turn.
const events = [
  userMessage(1, "please fix the parser"),
  note(2, "reasoning", "checking the parser"),
  toolCall(3, "call-1"),
  toolResult(4, "call-1"),
  note(5, "assistant", "the parser is fine"),
];

beforeEach(() => {
  Element.prototype.scrollIntoView = vi.fn() as unknown as Element["scrollIntoView"];
});

function renderStream(props: Partial<ComponentProps<typeof ChatStream>> = {}) {
  return render(<ChatStream events={events} hostSpeaker="kin" {...props} />);
}

describe("a running turn's prose", () => {
  it("shows a live note as body prose and keeps the tool rows behind the card", () => {
    const { container } = renderStream({ loading: true });

    // The reasoning is in the conversation the moment it arrives, as body
    // text: no card, no disclosure above it.
    const noteRow = container.querySelector<HTMLElement>('[data-message-key="note-2"]');
    expect(noteRow).not.toBeNull();
    expect(noteRow?.textContent).toContain("checking the parser");
    expect(noteRow?.closest("[aria-expanded]")).toBeNull();

    // The tool call is still a card, folded: its row is not drawn yet.
    const toggle = container.querySelector<HTMLButtonElement>("button[aria-expanded]");
    expect(toggle).not.toBeNull();
    expect(toggle?.getAttribute("aria-expanded")).toBe("false");
    expect(screen.queryByText("shell")).toBeNull();

    // The note comes before the card, in the order it happened.
    expect(
      noteRow!.compareDocumentPosition(toggle!) & Node.DOCUMENT_POSITION_FOLLOWING,
    ).toBeTruthy();

    fireEvent.click(toggle!);
    expect(screen.getByText("shell")).toBeTruthy();
  });

  it("leaves the settled turn in one collapsed card", () => {
    const { container } = renderStream();

    // Once the turn is done the same note is a step inside the one process
    // card, so it is not body text until the reader asks for the steps.
    expect(screen.queryByText("checking the parser")).toBeNull();
    expect(container.querySelector('[data-message-key="note-2"]')).toBeNull();

    const toggle = container.querySelector<HTMLButtonElement>("button[aria-expanded]");
    expect(toggle).not.toBeNull();
    fireEvent.click(toggle!);

    expect(container.querySelector('[data-message-key="note-2"]')).not.toBeNull();
    expect(screen.getByText("checking the parser")).toBeTruthy();
  });

  it("keeps a running tool's card live behind a streaming note", () => {
    // The call has no result yet, so the card is still working even though the
    // note beside it is now the newest thing on screen.
    const running = [
      userMessage(1, "please look"),
      toolCall(2, "call-1"),
      note(3, "reasoning", "waiting on the listing"),
    ];
    render(<ChatStream events={running} hostSpeaker="kin" loading />);
    expect(screen.getByText(t("chat.progress.summaryRunning", { activity: "shell" }))).toBeTruthy();
  });

  it("leaves an earlier round folded while a later round runs", () => {
    // A follow-up posts into the same task, so the task stays non-terminal —
    // but the first round already finished and must not re-open as prose.
    const followUp = [
      userMessage(1, "first request"),
      note(2, "reasoning", "first round thinking"),
      note(3, "assistant", "first round answer"),
      userMessage(4, "follow up"),
      note(5, "reasoning", "second round thinking"),
    ];
    const { container } = render(<ChatStream events={followUp} hostSpeaker="kin" loading />);

    // The live round's note is body prose...
    const liveNote = container.querySelector<HTMLElement>('[data-message-key="note-5"]');
    expect(liveNote?.textContent).toContain("second round thinking");

    // ...while the finished round stays one collapsed card: its note is not
    // body text until the reader asks for the steps.
    expect(container.querySelector('[data-message-key="note-2"]')).toBeNull();
    const toggles = container.querySelectorAll<HTMLButtonElement>("button[aria-expanded]");
    expect(toggles).toHaveLength(1);
    fireEvent.click(toggles[0]);
    expect(screen.getByText("first round thinking")).toBeTruthy();
  });

  it("keeps a settled process card even when it held only notes", () => {
    const onlyNotes = [
      userMessage(1, "please think"),
      note(2, "reasoning", "weighing the options"),
      note(3, "assistant", "settling on the parser"),
    ];
    const { container } = render(<ChatStream events={onlyNotes} hostSpeaker="kin" />);

    // The split is the running presentation. A finished turn with no tools
    // still folds into its card, exactly as it did before.
    expect(screen.queryByText("weighing the options")).toBeNull();
    const toggle = container.querySelector<HTMLButtonElement>("button[aria-expanded]");
    expect(toggle).not.toBeNull();
    fireEvent.click(toggle!);
    expect(screen.getByText("weighing the options")).toBeTruthy();
  });
});
